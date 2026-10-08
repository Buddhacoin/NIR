#import <AppKit/AppKit.h>

// Keep a real AppKit event loop alive while the local wallet service and its
// native setup window run. A shell/Node executable alone can appear frozen in
// the Dock even while its HTTP server is healthy.
@interface NIRLauncher : NSObject <NSApplicationDelegate>
@property NSTask *wallet;
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

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSString *node = [self nodeExecutable];
    NSString *script = [[NSBundle mainBundle].resourcePath
        stringByAppendingPathComponent:@"app/blockchain/wallet-macos-app.mjs"];
    if (!node || ![[NSFileManager defaultManager] fileExistsAtPath:script]) {
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"NIR Wallet не запущен";
        alert.informativeText = node ? @"Сборка приложения неполная." :
            @"Node.js, использованный для локальной сборки, больше не найден. Соберите приложение заново.";
        [alert runModal];
        [NSApp terminate:nil];
        return;
    }
    self.wallet = [NSTask new];
    self.wallet.executableURL = [NSURL fileURLWithPath:node];
    self.wallet.arguments = @[script];
    self.wallet.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
    };
    NSError *error = nil;
    if (![self.wallet launchAndReturnError:&error]) {
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"NIR Wallet не запущен";
        alert.informativeText = @"Не удалось запустить локальный кошелёк.";
        [alert runModal];
        [NSApp terminate:nil];
    }
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (self.wallet.isRunning) [self.wallet terminate];
    return NSTerminateNow;
}
@end

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
