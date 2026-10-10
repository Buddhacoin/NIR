#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <signal.h>

@interface NIRModelLauncher : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate>
@property NSTask *service;
@property NSWindow *window;
@property WKWebView *web;
@property NSFileHandle *output;
@property NSMutableData *pending;
@property NSURL *localURL;
@property BOOL groupStopped;
@property (strong) dispatch_source_t terminationSignal;
@end

@implementation NIRModelLauncher

+ (BOOL)verifyRuntimeAtResources:(NSString *)resources {
    NSString *verifier = [[NSBundle mainBundle].executablePath.stringByDeletingLastPathComponent
        stringByAppendingPathComponent:@"runtime-verifier"];
    NSString *configuration = [resources stringByAppendingPathComponent:@"NIR-RUNTIME.json"];
    NSFileManager *files = NSFileManager.defaultManager;
    if (![files isExecutableFileAtPath:verifier]) return NO;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:verifier];
    task.arguments = @[configuration];
    task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    if (![task launchAndReturnError:nil]) return NO;
    [task waitUntilExit];
    return task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0;
}

- (void)stopWithMessage:(NSString *)message {
    [self stopServiceGroup];
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"NIR Model Lab не запущен";
    alert.informativeText = message;
    [alert runModal];
    [NSApp terminate:nil];
}

- (void)stopServiceGroup {
    if (self.groupStopped || !self.service) return;
    self.groupStopped = YES;
    // The supervisor owns and drains its process group before exiting. Signal
    // only that live task; never signal a numeric group ID after it was reaped.
    if (self.service.isRunning) [self.service terminate];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    signal(SIGTERM, SIG_IGN);
    self.terminationSignal = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0,
        dispatch_get_main_queue());
    dispatch_source_set_event_handler(self.terminationSignal, ^{ [NSApp terminate:nil]; });
    dispatch_resume(self.terminationSignal);
    NSString *resources = [NSBundle mainBundle].resourcePath;
    if (![NIRModelLauncher verifyRuntimeAtResources:resources]) {
        [self stopWithMessage:@"Node.js или Python изменились после локальной сборки. Соберите приложение заново."];
        return;
    }
    NSData *data = [NSData dataWithContentsOfFile:[resources stringByAppendingPathComponent:@"NIR-RUNTIME.json"]];
    NSDictionary *runtime = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSDictionary *nodeBinding = [runtime isKindOfClass:NSDictionary.class] ? runtime[@"nodeExecutable"] : nil;
    NSDictionary *pythonBinding = [runtime isKindOfClass:NSDictionary.class] ? runtime[@"pythonExecutable"] : nil;
    NSString *node = [nodeBinding isKindOfClass:NSDictionary.class] ? nodeBinding[@"logicalPath"] : nil;
    NSString *python = [pythonBinding isKindOfClass:NSDictionary.class] ? pythonBinding[@"logicalPath"] : nil;
    NSString *root = [resources stringByAppendingPathComponent:@"app"];
    NSString *script = [root stringByAppendingPathComponent:@"blockchain/mining-practice-app-cli.mjs"];
    NSString *runner = [[[NSBundle mainBundle] executablePath] stringByDeletingLastPathComponent];
    runner = [runner stringByAppendingPathComponent:@"mining-runner"];
    NSFileManager *files = [NSFileManager defaultManager];
    if (![node isKindOfClass:NSString.class] || ![node hasPrefix:@"/"] ||
        ![files isExecutableFileAtPath:node] || ![python isKindOfClass:NSString.class] ||
        ![python hasPrefix:@"/"] || ![files isExecutableFileAtPath:python] ||
        ![[files attributesOfItemAtPath:script error:nil][NSFileType] isEqualToString:NSFileTypeRegular] ||
        ![files isExecutableFileAtPath:runner]) {
        [self stopWithMessage:@"Node.js или Python, использованные при локальной сборке, больше не доступны. Соберите приложение заново."];
        return;
    }
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 430, 800)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                  NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"NIR Model Lab · локальный тест";
    self.window.minSize = NSMakeSize(390, 600);
    [self.window center];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    self.web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self;
    self.web.UIDelegate = self;
    [self.window.contentView addSubview:self.web];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    self.service = [NSTask new];
    self.service.executableURL = [NSURL fileURLWithPath:runner];
    self.service.arguments = @[node, script, @"--embedded"];
    self.service.currentDirectoryURL = [NSURL fileURLWithPath:root isDirectory:YES];
    NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
    env[@"NIR_MINING_PYTHON"] = python;
    env[@"PYTHONNOUSERSITE"] = @"1";
    env[@"PYTHONDONTWRITEBYTECODE"] = @"1";
    [env removeObjectsForKeys:@[@"NODE_OPTIONS", @"NODE_PATH", @"PYTHONHOME", @"PYTHONPATH",
        @"PYTHONSTARTUP", @"PYTHONUSERBASE"]];
    self.service.environment = env;
    NSPipe *pipe = [NSPipe pipe];
    self.service.standardOutput = pipe;
    self.service.standardError = [NSFileHandle fileHandleWithNullDevice];
    self.output = pipe.fileHandleForReading;
    self.pending = [NSMutableData data];
    __weak NIRModelLauncher *weakSelf = self;
    self.output.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *chunk = [handle availableData];
        dispatch_async(dispatch_get_main_queue(), ^{
            NIRModelLauncher *owner = weakSelf;
            if (!owner) return;
            if (chunk.length == 0) { owner.output.readabilityHandler = nil; return; }
            if (owner.pending.length + chunk.length > 4096) {
                [owner stopWithMessage:@"Локальный сервис вернул слишком длинный ответ."];
                return;
            }
            [owner.pending appendData:chunk];
            NSString *text = [[NSString alloc] initWithData:owner.pending encoding:NSUTF8StringEncoding];
            if (!text) return;
            NSRange firstEnd = [text rangeOfString:@"\n"];
            if (firstEnd.location == NSNotFound) return;
            NSRange secondEnd = [text rangeOfString:@"\n" options:0
                range:NSMakeRange(NSMaxRange(firstEnd), text.length - NSMaxRange(firstEnd))];
            if (secondEnd.location == NSNotFound) return;
            NSString *line = [text substringToIndex:firstEnd.location];
            NSString *sessionLine = [text substringWithRange:NSMakeRange(NSMaxRange(firstEnd),
                secondEnd.location - NSMaxRange(firstEnd))];
            owner.output.readabilityHandler = nil;
            if (![line hasPrefix:@"NIR_MODEL_LAB_URL=http://127.0.0.1:"]) {
                [owner stopWithMessage:@"Локальная проверка модели не прошла предварительную проверку."];
                return;
            }
            NSString *url = [line substringFromIndex:@"NIR_MODEL_LAB_URL=".length];
            NSString *prefix = @"NIR_MODEL_LAB_SESSION=";
            NSString *token = [sessionLine hasPrefix:prefix] ? [sessionLine substringFromIndex:prefix.length] : @"";
            NSRegularExpression *tokenPattern = [NSRegularExpression regularExpressionWithPattern:@"^[0-9a-f]{64}$"
                options:0 error:nil];
            if ([tokenPattern numberOfMatchesInString:token options:0 range:NSMakeRange(0, token.length)] != 1) {
                [owner stopWithMessage:@"Локальный сеанс не прошёл проверку."];
                return;
            }
            NSURLComponents *parts = [NSURLComponents componentsWithString:url];
            if (![parts.scheme isEqualToString:@"http"] ||
                ![parts.host isEqualToString:@"127.0.0.1"] ||
                parts.port.integerValue < 1 || parts.port.integerValue > 65535 ||
                ![parts.path isEqualToString:@"/"] ||
                ![parts.query isEqualToString:@"local-app=1"] ||
                parts.user || parts.password || parts.fragment) {
                [owner stopWithMessage:@"Локальный адрес имеет неверный формат."];
                return;
            }
            owner.localURL = parts.URL;
            NSString *source = [NSString stringWithFormat:
                @"Object.defineProperty(window, '__NIR_MODEL_SESSION', {value: '%@', writable: false});", token];
            WKUserScript *script = [[WKUserScript alloc] initWithSource:source
                injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
            [owner.web.configuration.userContentController addUserScript:script];
            [owner.web loadRequest:[NSURLRequest requestWithURL:owner.localURL]];
        });
    };
    NSError *error = nil;
    if (![self.service launchAndReturnError:&error]) {
        self.output.readabilityHandler = nil;
        [self stopWithMessage:@"Не удалось запустить локальный сервис модели."];
        return;
    }
    self.service.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NIRModelLauncher *owner = weakSelf;
            if (!owner || !NSApp.isRunning) return;
            [owner stopServiceGroup];
            if (!owner.localURL) {
                [owner stopWithMessage:@"Локальный сервис не запустился. Проверьте зависимости и соберите приложение заново."];
            } else [NSApp terminate:nil];
        });
    };
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
 decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if (action.shouldPerformDownload && [url.scheme isEqualToString:@"blob"]) {
        decisionHandler(WKNavigationActionPolicyDownload);
    } else if (self.localURL && [url.scheme isEqualToString:@"http"] &&
               [url.host isEqualToString:@"127.0.0.1"] &&
               [url.port isEqualToNumber:self.localURL.port]) {
        decisionHandler(WKNavigationActionPolicyAllow);
    } else {
        decisionHandler(WKNavigationActionPolicyCancel);
    }
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
 initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Загрузка модели на этот Mac";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"Продолжить"];
    [alert addButtonWithTitle:@"Отмена"];
    completionHandler([alert runModal] == NSAlertFirstButtonReturn);
}

- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action
 didBecomeDownload:(WKDownload *)download API_AVAILABLE(macos(11.3)) {
    download.delegate = self;
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response
 suggestedFilename:(NSString *)filename completionHandler:(void (^)(NSURL *))completionHandler API_AVAILABLE(macos(11.3)) {
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = filename;
    if ([panel runModal] == NSModalResponseOK) completionHandler(panel.URL);
    else completionHandler(nil);
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    self.output.readabilityHandler = nil;
    [self stopServiceGroup];
    return NSTerminateNow;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--verify-runtime") == 0) {
            if ([NIRModelLauncher verifyRuntimeAtResources:NSBundle.mainBundle.resourcePath]) return 0;
            fputs("runtime binding verification failed\n", stderr);
            return 1;
        }
        if (argc != 1) return 2;
        NSApplication *app = [NSApplication sharedApplication];
        app.activationPolicy = NSApplicationActivationPolicyRegular;
        NIRModelLauncher *delegate = [NIRModelLauncher new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
