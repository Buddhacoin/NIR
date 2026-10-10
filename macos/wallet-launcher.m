#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <signal.h>

static NSString *NIRPreferredLanguage(void) {
    CFPropertyListRef value = CFPreferencesCopyAppValue(CFSTR("language"), CFSTR("org.nir.wallet-setup-test"));
    NSString *language = value && CFGetTypeID(value) == CFStringGetTypeID() &&
        [(__bridge NSString *)value isEqualToString:@"en"] ? @"en" : @"ru";
    if (value) CFRelease(value);
    return language;
}

static NSString *NIRLauncherText(NSString *russian) {
    if (![NIRPreferredLanguage() isEqualToString:@"en"]) return russian;
    NSDictionary<NSString *, NSString *> *copy = @{
        @"NIR Wallet не запущен": @"NIR Wallet could not start",
        @"Локальный сервис прислал некорректный адрес.": @"The local service returned an invalid address.",
        @"Сборка приложения неполная.": @"The app build is incomplete.",
        @"Node.js, использованный для локальной сборки, больше не найден. Соберите приложение заново.": @"The Node.js used for this local build is no longer available. Rebuild the app.",
        @"Локальный сервис завершился до открытия кошелька.": @"The local service stopped before the wallet opened.",
        @"NIR Wallet · локальный тест": @"NIR Wallet · local test",
    };
    return copy[russian] ?: russian;
}

static NSURL *NIRLocalWalletURL(NSString *line) {
    NSURLComponents *components = line ? [NSURLComponents componentsWithString:line] : nil;
    NSInteger port = components.port.integerValue;
    if (![components.scheme isEqualToString:@"http"] ||
        ![components.host isEqualToString:@"127.0.0.1"] ||
        !components.port || port < 1 || port > 65535 ||
        ![components.path isEqualToString:@"/"] ||
        ![components.query isEqualToString:@"local-demo=1&local-app=1"] ||
        components.user || components.password || components.fragment) return nil;
    return components.URL;
}

static BOOL NIRTrustedLanguageMessage(NSString *name, BOOL mainFrame, id body,
                                      NSURL *frameURL, NSURL *origin) {
    if (![name isEqualToString:@"nirLanguage"] || !mainFrame ||
        ![body isKindOfClass:NSString.class] ||
        ![@[@"ru", @"en"] containsObject:body] || !origin) return NO;
    NSURL *source = NIRLocalWalletURL(frameURL.absoluteString);
    return source && [source.scheme isEqualToString:origin.scheme] &&
        [source.host isEqualToString:origin.host] &&
        source.port.integerValue == origin.port.integerValue;
}

// The Node service starts in its own process group. Closing the app must also
// close an in-progress native onboarding dialog, not orphan a signing bridge.
@interface NIRLauncher : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler>
@property NSTask *wallet;
@property NSWindow *window;
@property WKWebView *webView;
@property NSPipe *output;
@property NSMutableData *startupData;
@property NSURL *origin;
@property (strong) dispatch_source_t terminationSignal;
@property BOOL walletGroupStopped;
@end

@implementation NIRLauncher

- (NSString *)nodeExecutable {
    NSFileManager *files = [NSFileManager defaultManager];
    NSString *config = [[NSBundle mainBundle].resourcePath
        stringByAppendingPathComponent:@"NIR-RUNTIME.json"];
    NSData *bytes = [NSData dataWithContentsOfFile:config];
    NSDictionary *runtime = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
    NSString *path = [runtime isKindOfClass:NSDictionary.class] ? runtime[@"nodeExecutable"] : nil;
    return [path isKindOfClass:NSString.class] && [path hasPrefix:@"/"] &&
        [files isExecutableFileAtPath:path] ? path : nil;
}

- (void)failWithMessage:(NSString *)message {
    NSAlert *alert = [NSAlert new];
    alert.messageText = NIRLauncherText(@"NIR Wallet не запущен");
    alert.informativeText = NIRLauncherText(message);
    [alert runModal];
    [NSApp terminate:nil];
}

- (void)stopWalletGroup {
    if (self.walletGroupStopped || !self.wallet) return;
    self.walletGroupStopped = YES;
    pid_t leader = self.wallet.processIdentifier;
    if (leader <= 0) return;
    // NSTask can report a dead leader while onboarding/signing descendants are
    // still alive. The group id remains the original leader's pid until all
    // members exit; signal it once, immediately, before that id can be reused.
    if (kill(-leader, SIGTERM) != 0 && self.wallet.isRunning) [self.wallet terminate];
}

- (void)showWalletAtURL:(NSURL *)url {
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    // The onboarding helper writes only this non-secret preference. Seed the
    // ephemeral WKWebView before app.js runs; no key or URL parameter is used.
    NSString *localeScript = [NSString stringWithFormat:
        @"try { localStorage.setItem('nir-language', '%@'); } catch (_) {}",
        NIRPreferredLanguage()];
    WKUserScript *language = [[WKUserScript alloc] initWithSource:localeScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
    [configuration.userContentController addUserScript:language];
    [configuration.userContentController addScriptMessageHandler:self name:@"nirLanguage"];
    self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 480, 760)
                                       configuration:configuration];
    self.webView.navigationDelegate = self;
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 480, 760)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                  NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = NIRLauncherText(@"NIR Wallet · локальный тест");
    self.window.contentMinSize = NSMakeSize(360, 600);
    self.window.contentView = self.webView;
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url
        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:20]];
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!NIRTrustedLanguageMessage(message.name, message.frameInfo.isMainFrame,
        message.body, message.frameInfo.request.URL, self.origin)) return;
    CFPreferencesSetAppValue(CFSTR("language"),
        [message.body isEqualToString:@"en"] ? CFSTR("en") : CFSTR("ru"),
        CFSTR("org.nir.wallet-setup-test"));
    CFPreferencesAppSynchronize(CFSTR("org.nir.wallet-setup-test"));
}

- (void)consumeStartupData:(NSData *)data {
    if (self.origin || data.length == 0) return;
    if (self.startupData.length + data.length > 512) {
        [self failWithMessage:@"Локальный сервис прислал некорректный адрес."];
        return;
    }
    [self.startupData appendData:data];
    const unsigned char *bytes = self.startupData.bytes;
    NSUInteger end = NSNotFound;
    for (NSUInteger index = 0; index < self.startupData.length; index++) {
        if (bytes[index] == '\n') { end = index; break; }
    }
    if (end == NSNotFound) return;
    NSString *line = [[NSString alloc] initWithData:[self.startupData subdataWithRange:NSMakeRange(0, end)]
                                         encoding:NSUTF8StringEncoding];
    NSURL *url = NIRLocalWalletURL(line);
    if (!url) {
        [self failWithMessage:@"Локальный сервис прислал некорректный адрес."];
        return;
    }
    NSInteger port = url.port.integerValue;
    self.origin = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld", (long)port]];
    [self showWalletAtURL:url];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    signal(SIGTERM, SIG_IGN);
    self.terminationSignal = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.terminationSignal, ^{ [NSApp terminate:nil]; });
    dispatch_resume(self.terminationSignal);

    NSString *node = [self nodeExecutable];
    NSString *resources = [NSBundle mainBundle].resourcePath;
    NSString *script = [resources stringByAppendingPathComponent:@"app/blockchain/wallet-macos-app.mjs"];
    NSString *runner = [[NSBundle mainBundle].executablePath
        stringByDeletingLastPathComponent];
    runner = [runner stringByAppendingPathComponent:@"wallet-runner"];
    if (!node || ![[NSFileManager defaultManager] fileExistsAtPath:script] ||
        ![[NSFileManager defaultManager] isExecutableFileAtPath:runner]) {
        [self failWithMessage:node ? @"Сборка приложения неполная." :
            @"Node.js, использованный для локальной сборки, больше не найден. Соберите приложение заново."];
        return;
    }
    self.startupData = [NSMutableData data];
    self.output = [NSPipe pipe];
    self.wallet = [NSTask new];
    self.wallet.executableURL = [NSURL fileURLWithPath:runner];
    self.wallet.arguments = @[node, script];
    self.wallet.standardOutput = self.output;
    __weak NIRLauncher *weakSelf = self;
    self.output.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = [handle availableData];
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf consumeStartupData:data]; });
    };
    self.wallet.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf stopWalletGroup];
            if (!weakSelf.origin) {
                [weakSelf failWithMessage:@"Локальный сервис завершился до открытия кошелька."];
            } else {
                [NSApp terminate:nil];
            }
        });
    };
    NSError *error = nil;
    if (![self.wallet launchAndReturnError:&error]) {
        [self failWithMessage:@"Не удалось запустить локальный кошелёк."];
    }
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
 decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    BOOL sameOrigin = [url.scheme isEqualToString:@"http"] &&
        [url.host isEqualToString:@"127.0.0.1"] &&
        url.port.integerValue == self.origin.port.integerValue &&
        !url.user && !url.password;
    decisionHandler(sameOrigin ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    self.output.fileHandleForReading.readabilityHandler = nil;
    [self stopWalletGroup];
    return NSTerminateNow;
}
@end

#ifdef NIR_LAUNCHER_URL_SMOKE_TEST
int main(void) {
    @autoreleasepool {
        NSArray<NSString *> *bad = @[
            @"http://localhost:1234/?local-demo=1&local-app=1",
            @"http://127.0.0.1:8788/?local-demo=1&local-app=1#fragment",
            @"http://evil.test:1234/?local-demo=1&local-app=1",
            @"https://127.0.0.1:1234/?local-demo=1&local-app=1",
            @"http://127.0.0.1:0/?local-demo=1&local-app=1",
            @"http://127.0.0.1:1234/other?local-demo=1&local-app=1",
            @"http://127.0.0.1:1234/?local-demo=1&local-app=0",
            @"http://user@127.0.0.1:1234/?local-demo=1&local-app=1"
        ];
        if (!NIRLocalWalletURL(@"http://127.0.0.1:1234/?local-demo=1&local-app=1")) return 1;
        for (NSString *line in bad) if (NIRLocalWalletURL(line)) return 2;
        NSURL *origin = [NSURL URLWithString:@"http://127.0.0.1:1234"];
        NSURL *page = [NSURL URLWithString:@"http://127.0.0.1:1234/?local-demo=1&local-app=1"];
        if (!NIRTrustedLanguageMessage(@"nirLanguage", YES, @"en", page, origin)) return 3;
        if (!NIRTrustedLanguageMessage(@"nirLanguage", YES, @"ru", page, origin)) return 4;
        if (NIRTrustedLanguageMessage(@"nirLanguage", NO, @"en", page, origin) ||
            NIRTrustedLanguageMessage(@"other", YES, @"en", page, origin) ||
            NIRTrustedLanguageMessage(@"nirLanguage", YES, @"fr", page, origin) ||
            NIRTrustedLanguageMessage(@"nirLanguage", YES, @42, page, origin) ||
            NIRTrustedLanguageMessage(@"nirLanguage", YES, @"en",
                [NSURL URLWithString:@"http://127.0.0.1:5678/?local-demo=1&local-app=1"], origin) ||
            NIRTrustedLanguageMessage(@"nirLanguage", YES, @"en",
                [NSURL URLWithString:@"http://evil.test:1234/?local-demo=1&local-app=1"], origin) ||
            NIRTrustedLanguageMessage(@"nirLanguage", YES, @"en",
                [NSURL URLWithString:@"http://127.0.0.1:1234/?local-demo=1&local-app=0"], origin)) return 5;
    }
    return 0;
}
#else
int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        NIRLauncher *delegate = [NIRLauncher new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
#endif
