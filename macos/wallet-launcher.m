#import <AppKit/AppKit.h>
#import <Security/Security.h>

// Keep a real AppKit event loop alive while the local wallet service and its
// native setup window run. A shell/Node executable alone can appear frozen in
// the Dock even while its HTTP server is healthy.
@interface NIRLauncher : NSObject <NSApplicationDelegate>
@property NSTask *wallet;
@end

@implementation NIRLauncher

+ (BOOL)verifyRuntimeAtResources:(NSString *)resources {
    SecStaticCodeRef ownCode = NULL;
    OSStatus created = SecStaticCodeCreateWithPath((__bridge CFURLRef)NSBundle.mainBundle.bundleURL,
        kSecCSDefaultFlags, &ownCode);
    if (created != errSecSuccess || !ownCode) return NO;
    SecCSFlags flags = kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode;
    OSStatus valid = SecStaticCodeCheckValidity(ownCode, flags, NULL);
    CFRelease(ownCode);
    if (valid != errSecSuccess) return NO;
    NSString *verifier = [[NSBundle mainBundle].executablePath.stringByDeletingLastPathComponent
        stringByAppendingPathComponent:@"runtime-verifier"];
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:verifier]) return NO;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:verifier];
    task.arguments = @[[resources stringByAppendingPathComponent:@"NIR-RUNTIME.json"]];
    task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    if (![task launchAndReturnError:nil]) return NO;
    [task waitUntilExit];
    return task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0;
}

- (NSString *)nodeExecutable {
    NSFileManager *files = [NSFileManager defaultManager];
    NSString *config = [[NSBundle mainBundle].resourcePath
        stringByAppendingPathComponent:@"NIR-RUNTIME.json"];
    NSData *bytes = [NSData dataWithContentsOfFile:config];
    NSDictionary *runtime = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
    NSDictionary *binding = [runtime isKindOfClass:NSDictionary.class] &&
        [runtime[@"format"] isEqualToString:@"nir-wallet-runtime-binding-v1"] ?
        runtime[@"nodeExecutable"] : nil;
    NSString *path = [binding isKindOfClass:NSDictionary.class] ? binding[@"logicalPath"] : nil;
    return [path isKindOfClass:NSString.class] && [path hasPrefix:@"/"] &&
        [files isExecutableFileAtPath:path] ? path : nil;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    if (![NIRLauncher verifyRuntimeAtResources:NSBundle.mainBundle.resourcePath]) {
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"NIR Wallet не запущен";
        alert.informativeText = @"Node.js или файлы приложения изменились после локальной сборки. Соберите приложение заново.";
        [alert runModal];
        [NSApp terminate:nil];
        return;
    }
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
    self.wallet.environment = @{ @"HOME": NSHomeDirectory(), @"TMPDIR": NSTemporaryDirectory(),
        @"PATH": @"/usr/bin:/bin", @"LANG": @"en_US.UTF-8" };
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

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--verify-runtime") == 0) {
            if ([NIRLauncher verifyRuntimeAtResources:NSBundle.mainBundle.resourcePath]) return 0;
            fputs("runtime binding verification failed\n", stderr);
            return 1;
        }
        if (argc != 1) return 2;
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        NIRLauncher *delegate = [NIRLauncher new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
