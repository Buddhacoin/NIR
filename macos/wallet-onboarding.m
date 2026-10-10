#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <sys/stat.h>

#if defined(NIR_ONBOARDING_LOCALE_SMOKE_TEST)
static CFStringRef const NIRPreferenceDomain = CFSTR("org.nir.wallet-locale-smoke-test");
#else
static CFStringRef const NIRPreferenceDomain = CFSTR("org.nir.wallet-setup-test");
#endif
static BOOL NIREnglish(void) {
    CFPropertyListRef value = CFPreferencesCopyAppValue(CFSTR("language"), NIRPreferenceDomain);
    BOOL english = value && CFGetTypeID(value) == CFStringGetTypeID() &&
        [(__bridge NSString *)value isEqualToString:@"en"];
    if (value) CFRelease(value);
    return english;
}
static void NIRSetEnglish(BOOL english) {
    CFPreferencesSetAppValue(CFSTR("language"), english ? CFSTR("en") : CFSTR("ru"), NIRPreferenceDomain);
    CFPreferencesAppSynchronize(NIRPreferenceDomain);
}
static NSString *NIRTranslate(NSString *source) {
    static NSDictionary<NSString *, NSString *> *copy;
    static NSDictionary<NSString *, NSString *> *reverse;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        copy = @{
            @"С возвращением!": @"Welcome back!",
            @"NIR Wallet · локальная тестовая сеть": @"NIR Wallet · local test network",
            @"Создать": @"Create", @"Открыть": @"Open", @"Восстановить": @"Restore",
            @"Новый адрес NIR": @"New NIR address", @"Создайте кошелёк": @"Create a wallet",
            @"Восстановление": @"Recovery", @"Код восстановления": @"Recovery code",
            @"Код, записанный при создании кошелька": @"Code saved when the wallet was created",
            @"Пароль": @"Password", @"Новый пароль": @"New password",
            @"От 12 символов": @"At least 12 characters",
            @"Введите пароль кошелька": @"Enter wallet password",
            @"Повторите пароль": @"Repeat password",
            @"Повторите новый пароль": @"Repeat new password",
            @"Введите тот же пароль": @"Enter the same password",
            @"Ваш полный адрес": @"Your full address", @"Ваш адрес": @"Your address",
            @"Полный адрес nir1… из вашей записи": @"Full nir1… address from your record",
            @"Резервная копия этого адреса": @"Backup for this address",
            @"Другой файл…": @"Another file…", @"Создать тестовый кошелёк": @"Create test wallet",
            @"Создать кошелёк": @"Create wallet", @"Открыть NIR Wallet": @"Open NIR Wallet",
            @"Восстановить кошелёк": @"Restore wallet", @"Отмена": @"Cancel",
            @"← Назад": @"← Back", @"Создать новый": @"Create new",
            @"Новый код восстановления": @"New recovery code",
            @"На этом Mac ещё нет кошелька": @"No wallet on this Mac yet",
            @"Код восстановления покажем после создания. Сохраните его отдельно.": @"A recovery code will appear after creation. Store it separately.",
            @"Пароль откроет выбранный кошелёк. Для операций он потребуется снова.": @"The password opens the selected wallet. It will be needed again for operations.",
            @"Создайте кошелёк, чтобы начать работу.": @"Create a wallet to get started.",
            @"Нужны копия, код восстановления и ранее записанный адрес.": @"You need a backup, recovery code and the address you previously recorded.",
            @"Выбрать": @"Select", @"Выберите резервную копию NIR": @"Select a NIR backup",
            @"NIR Wallet · новый адрес": @"NIR Wallet · new address",
            @"На этом Mac нет сохранённого кошелька. Выберите «Создать».": @"No saved wallet on this Mac. Select Create.",
            @"Введите пароль выбранного кошелька.": @"Enter the selected wallet password.",
            @"Выберите копию из списка или нажмите «Другой файл…».": @"Select a listed backup or choose Another file…",
            @"Пароль слишком короткий: нужно от 12 символов.": @"Password too short: at least 12 characters required.",
            @"Пароли не совпадают. Проверьте ввод.": @"Passwords do not match. Check your entry.",
            @"Введите полный адрес, записанный при создании кошелька.": @"Enter the full address recorded when the wallet was created.",
            @"Введите код восстановления.": @"Enter the recovery code.",
            @"Выберите кошелёк и введите его пароль.": @"Select a wallet and enter its password.",
            @"Проверьте данные": @"Check the information",
            @"Создать новый код восстановления?": @"Create a new recovery code?",
            @"Понадобится сохранить новую резервную копию отдельно от нового кода. Старые копия и код продолжат работать. Если они могли попасть к посторонним, создайте новый адрес и переведите на него средства.": @"Save a new backup separately from the new code. The old backup and code will continue to work. If someone else may have obtained them, create a new address and transfer your funds there.",
            @"Продолжить": @"Continue", @"Подключите кошелёк": @"Connect wallet",
            @"Введите эти 8 цифр в окне браузера. Это не код восстановления. Код действует 10 минут.": @"Enter these eight digits in the browser window. This is not a recovery code. The code expires in 10 minutes.",
            @"Готово": @"Done", @"Копировать код": @"Copy code", @"Приватный ключ": @"Private key",
            @"Для этого адреса нужны И код, И зашифрованная копия. Один код не спасёт при потере Mac. Сохраните копию в выбранное место, предпочтительно на отдельный носитель, а код храните отдельно. Каждый новый адрес требует своей копии. Не отправляйте их никому.": @"This address needs BOTH the code AND an encrypted backup. The code alone cannot restore the wallet if this Mac is lost. Save the backup, preferably on separate media, and keep the code elsewhere. Every new address needs its own backup. Never send them to anyone.",
            @"Это полный приватный ключ. Любой, кто его увидит, сможет использовать этот адрес. Показывайте и копируйте его только в безопасном месте.": @"This is the full private key. Anyone who sees it can use this address. Show or copy it only in a safe place.",
            @"Сохранить копию": @"Save backup", @"Копировать": @"Copy",
            @"Отложить настройку": @"Set up later", @"Копия остаётся на том же диске": @"Backup remains on the same disk",
            @"При потере или поломке этого Mac код без копии не восстановит адрес. Лучше выбрать отдельный носитель. Приложение не может проверить, где физически находится выбранное хранилище.": @"If this Mac is lost or fails, the code without a backup cannot restore the address. Separate media is safer. The app cannot verify the physical location of storage you choose.",
            @"Выбрать другое место": @"Choose another location", @"Сохранить всё равно": @"Save anyway",
            @"Не удалось сохранить копию": @"Could not save backup",
            @"Выберите новое имя в доступной папке и повторите. Неудачный частичный файл может остаться — не используйте его как копию. Существующие файлы не заменяются.": @"Choose a new name in a writable folder and retry. A failed partial file may remain; do not use it as a backup. Existing files are not replaced.",
        };
        NSMutableDictionary *reversed = [NSMutableDictionary dictionaryWithCapacity:copy.count];
        [copy enumerateKeysAndObjectsUsingBlock:^(NSString *ru, NSString *en, BOOL *stop) { reversed[en] = ru; }];
        reverse = [reversed copy];
    });
    return NIREnglish() ? (copy[source] ?: source) : (reverse[source] ?: source);
}

// Local-test onboarding. Passwords leave this process only through the private
// stdout pipe to the vault process, never through argv, URLs or browser storage.
@interface NIRSetup : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property NSWindow *window;
@property NSSegmentedControl *modes;
@property NSTextField *passwordLabel;
@property NSTextField *secondLabel;
@property NSTextField *recoveryLabel;
@property NSTextField *addressLabel;
@property NSSecureTextField *password;
@property NSSecureTextField *confirmation;
@property NSTextField *recoveryCode;
@property NSTextField *address;
@property NSTextField *pathLabel;
@property NSPopUpButton *accountMenu;
@property NSArray<NSDictionary *> *wallets;
@property NSString *preferredPath;
@property NSPopUpButton *backupMenu;
@property NSTextField *backupLabel;
@property NSButton *importBackup;
@property NSArray<NSDictionary *> *backups;
@property BOOL createOnly;
@property NSTextField *titleLabel;
@property NSTextField *subtitleLabel;
@property NSImageView *logo;
@property NSTextField *hint;
@property NSButton *action;
@property NSButton *back;
@property NSButton *createLink;
@property NSButton *restoreLink;
@property NSButton *renewButton;
@property NSButton *cancelButton;
@property NSPopUpButton *languageMenu;
@property NSString *selectedPath;
@property BOOL submitted;
@end

@implementation NIRSetup

- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size color:(NSColor *)color {
    NSTextField *field = [NSTextField labelWithString:text];
    field.frame = frame;
    field.font = [NSFont systemFontOfSize:size];
    field.textColor = color;
    field.lineBreakMode = NSLineBreakByTruncatingMiddle;
    return field;
}

- (NSTextField *)input:(NSRect)frame secure:(BOOL)secure {
    NSTextField *field = secure ? [[NSSecureTextField alloc] initWithFrame:frame]
                                : [[NSTextField alloc] initWithFrame:frame];
    field.font = [NSFont systemFontOfSize:15];
    field.bezeled = YES;
    field.bezelStyle = NSTextFieldRoundedBezel;
    return field;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 390, 580)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"NIR Wallet";
    self.window.delegate = self;
    [self.window center];
    NSView *content = [[NSView alloc] initWithFrame:self.window.contentView.bounds];
    content.wantsLayer = YES;
    content.layer.backgroundColor = [NSColor colorWithCalibratedWhite:0.975 alpha:1].CGColor;
    self.window.contentView = content;
    self.languageMenu = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(278, 538, 84, 30)
                                                  pullsDown:NO];
    [self.languageMenu addItemsWithTitles:@[@"Русский", @"English"]];
    [self.languageMenu selectItemAtIndex:NIREnglish() ? 1 : 0];
    self.languageMenu.target = self;
    self.languageMenu.action = @selector(changeLanguage:);
    [content addSubview:self.languageMenu];

    self.logo = [[NSImageView alloc] initWithFrame:NSMakeRect(213, 302, 64, 64)];
    NSString *iconPath = [[NSBundle mainBundle] pathForResource:@"NIR" ofType:@"icns"];
    self.logo.image = iconPath ? [[NSImage alloc] initWithContentsOfFile:iconPath] : nil;
    self.logo.imageScaling = NSImageScaleProportionallyUpOrDown;
    [content addSubview:self.logo];

    self.titleLabel = [self label:@"С возвращением!" frame:NSMakeRect(28, 253, 434, 38)
                            size:26 color:NSColor.labelColor];
    self.titleLabel.font = [NSFont systemFontOfSize:26 weight:NSFontWeightSemibold];
    self.titleLabel.alignment = NSTextAlignmentCenter;
    [content addSubview:self.titleLabel];
    self.subtitleLabel = [self label:@"NIR Wallet · тестовая сеть"
                               frame:NSMakeRect(28, 225, 434, 24) size:14
                               color:NSColor.secondaryLabelColor];
    self.subtitleLabel.alignment = NSTextAlignmentCenter;
    [content addSubview:self.subtitleLabel];

    self.modes = [NSSegmentedControl segmentedControlWithLabels:
        @[@"Создать", @"Открыть", @"Восстановить"]
        trackingMode:NSSegmentSwitchTrackingSelectOne target:self action:@selector(changeMode:)];
    self.modes.frame = NSMakeRect(28, 335, 434, 32);
    self.modes.selectedSegment = 0;
    self.modes.hidden = YES;
    [content addSubview:self.modes];

    self.recoveryLabel = [self label:@"Код восстановления" frame:NSMakeRect(28, 300, 434, 20)
                                    size:13 color:NSColor.secondaryLabelColor];
    [content addSubview:self.recoveryLabel];
    self.recoveryCode = [self input:NSMakeRect(28, 266, 434, 30) secure:NO];
    self.recoveryCode.placeholderString = @"Код, записанный при создании кошелька";
    [content addSubview:self.recoveryCode];

    self.passwordLabel = [self label:@"Пароль" frame:NSMakeRect(28, 234, 434, 20)
                                    size:13 color:NSColor.secondaryLabelColor];
    [content addSubview:self.passwordLabel];
    self.password = (NSSecureTextField *)[self input:NSMakeRect(28, 198, 434, 30) secure:YES];
    self.password.placeholderString = @"От 12 символов";
    [content addSubview:self.password];
    self.secondLabel = [self label:@"Повторите пароль" frame:NSMakeRect(28, 169, 434, 20)
                                  size:13 color:NSColor.secondaryLabelColor];
    [content addSubview:self.secondLabel];
    self.confirmation = (NSSecureTextField *)[self input:NSMakeRect(28, 133, 434, 30) secure:YES];
    self.confirmation.placeholderString = @"Введите тот же пароль";
    [content addSubview:self.confirmation];

    self.addressLabel = [self label:@"Ваш полный адрес" frame:NSMakeRect(28, 108, 434, 20)
                                  size:13 color:NSColor.secondaryLabelColor];
    [content addSubview:self.addressLabel];
    self.address = [self input:NSMakeRect(28, 74, 434, 30) secure:NO];
    self.address.placeholderString = @"Полный адрес nir1… из вашей записи";
    [content addSubview:self.address];
    self.pathLabel = [self label:@"" frame:NSMakeRect(28, 303, 434, 23)
                                 size:13 color:NSColor.secondaryLabelColor];
    [content addSubview:self.pathLabel];
    self.accountMenu = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(28, 262, 434, 34)
                                                   pullsDown:NO];
    self.accountMenu.target = self;
    self.accountMenu.action = @selector(selectAccount:);
    [content addSubview:self.accountMenu];
    self.backupLabel = [self label:@"Резервная копия этого адреса"
                              frame:NSMakeRect(28, 365, 434, 20) size:13
                              color:NSColor.secondaryLabelColor];
    [content addSubview:self.backupLabel];
    self.backupMenu = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(28, 328, 300, 34)
                                                  pullsDown:NO];
    self.backupMenu.target = self;
    self.backupMenu.action = @selector(selectBackup:);
    [content addSubview:self.backupMenu];
    self.importBackup = [NSButton buttonWithTitle:@"Другой файл…"
                                            target:self action:@selector(importBackup:)];
    self.importBackup.frame = NSMakeRect(335, 328, 127, 34);
    self.importBackup.bezelStyle = NSBezelStyleRounded;
    [content addSubview:self.importBackup];
    self.hint = [self label:@"" frame:NSMakeRect(28, 83, 434, 34)
                            size:13 color:NSColor.secondaryLabelColor];
    self.hint.maximumNumberOfLines = 2;
    self.hint.lineBreakMode = NSLineBreakByWordWrapping;
    [content addSubview:self.hint];

    self.action = [NSButton buttonWithTitle:@"Создать тестовый кошелёк"
                                    target:self action:@selector(submit:)];
    self.action.frame = NSMakeRect(28, 50, 434, 44);
    self.action.bordered = NO;
    self.action.wantsLayer = YES;
    self.action.layer.cornerRadius = 13;
    self.action.layer.backgroundColor = NSColor.blackColor.CGColor;
    self.action.contentTintColor = NSColor.whiteColor;
    self.action.keyEquivalent = @"\r";
    [content addSubview:self.action];
    self.cancelButton = [NSButton buttonWithTitle:@"Отмена" target:self action:@selector(cancel:)];
    self.cancelButton.hidden = YES;
    [content addSubview:self.cancelButton];
    self.back = [NSButton buttonWithTitle:@"← Назад" target:self action:@selector(openMode:)];
    self.back.bordered = NO;
    self.back.frame = NSMakeRect(23, 0, 95, 28);
    self.back.contentTintColor = NSColor.secondaryLabelColor;
    [content addSubview:self.back];
    self.createLink = [NSButton buttonWithTitle:@"Создать новый" target:self action:@selector(createMode:)];
    self.createLink.bordered = NO;
    self.createLink.frame = NSMakeRect(40, 12, 180, 27);
    self.createLink.contentTintColor = NSColor.secondaryLabelColor;
    [content addSubview:self.createLink];
    self.restoreLink = [NSButton buttonWithTitle:@"Восстановить" target:self action:@selector(restoreMode:)];
    self.restoreLink.bordered = NO;
    self.restoreLink.frame = NSMakeRect(270, 12, 180, 27);
    self.restoreLink.contentTintColor = NSColor.secondaryLabelColor;
    [content addSubview:self.restoreLink];
    self.renewButton = [NSButton buttonWithTitle:@"Новый код восстановления"
                                            target:self action:@selector(renewCode:)];
    self.renewButton.bordered = NO;
    self.renewButton.contentTintColor = NSColor.secondaryLabelColor;
    [content addSubview:self.renewButton];

    [self.accountMenu removeAllItems];
    for (NSUInteger index = 0; index < self.wallets.count; index++) {
        NSDictionary *wallet = self.wallets[index];
        NSString *address = wallet[@"address"];
        NSString *shortAddress = [NSString stringWithFormat:@"%@…%@",
            [address substringToIndex:MIN((NSUInteger)12, address.length)],
            [address substringFromIndex:address.length - MIN((NSUInteger)8, address.length)]];
        [self.accountMenu addItemWithTitle:[NSString stringWithFormat:@"Кошелёк %lu · %@",
            (unsigned long)(index + 1), shortAddress]];
        self.accountMenu.lastItem.toolTip = address;
    }
    [self.backupMenu removeAllItems];
    for (NSUInteger index = 0; index < self.backups.count; index++) {
        NSDictionary *backup = self.backups[index];
        NSString *address = backup[@"address"];
        [self.backupMenu addItemWithTitle:[NSString stringWithFormat:@"Копия %lu · %@…%@",
            (unsigned long)(index + 1), [address substringToIndex:MIN((NSUInteger)12, address.length)],
            [address substringFromIndex:address.length - MIN((NSUInteger)8, address.length)]]];
        self.backupMenu.lastItem.toolTip = address;
    }
    if (self.createOnly) {
        self.window.title = @"NIR Wallet · новый адрес";
        self.modes.hidden = YES;
        self.modes.selectedSegment = 0;
    } else if (self.wallets.count > 0) {
        self.modes.selectedSegment = 1;
        NSUInteger preferredIndex = [self.wallets indexOfObjectPassingTest:
            ^BOOL(NSDictionary *wallet, NSUInteger index, BOOL *stop) {
                return [wallet[@"path"] isEqualToString:self.preferredPath];
            }];
        NSUInteger selectedIndex = preferredIndex == NSNotFound ? 0 : preferredIndex;
        self.selectedPath = self.wallets[selectedIndex][@"path"];
        [self.accountMenu selectItemAtIndex:selectedIndex];
    }
    [self refresh];
    [self.window center];
#if !defined(NIR_ONBOARDING_SMOKE_TEST) && !defined(NIR_ONBOARDING_SMOKE_RESTORE_TEST) && !defined(NIR_ONBOARDING_SMOKE_OPEN_TEST) && !defined(NIR_ONBOARDING_SMOKE_RENEW_TEST)
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
#endif
}

- (NSString *)mode {
    return @[@"create", @"open", @"restore"][(NSUInteger)self.modes.selectedSegment];
}

- (void)localizeControls {
    self.window.title = NIRTranslate(self.window.title);
    for (NSTextField *field in @[self.titleLabel, self.subtitleLabel, self.recoveryLabel,
                                  self.passwordLabel, self.secondLabel, self.addressLabel,
                                  self.pathLabel, self.backupLabel, self.hint]) {
        field.stringValue = NIRTranslate(field.stringValue);
    }
    for (NSTextField *field in @[self.recoveryCode, self.password, self.confirmation, self.address]) {
        if (field.placeholderString) field.placeholderString = NIRTranslate(field.placeholderString);
    }
    for (NSButton *button in @[self.importBackup, self.action, self.cancelButton, self.back,
                                self.createLink, self.restoreLink, self.renewButton]) {
        button.title = NIRTranslate(button.title);
    }
    self.action.attributedTitle = [[NSAttributedString alloc] initWithString:self.action.title
        attributes:@{NSForegroundColorAttributeName:NSColor.whiteColor,
                     NSFontAttributeName:[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold]}];
    for (NSUInteger index = 0; index < MIN(self.wallets.count, self.accountMenu.numberOfItems); index++) {
        NSString *address = self.wallets[index][@"address"];
        NSString *shortAddress = [NSString stringWithFormat:@"%@…%@",
            [address substringToIndex:MIN((NSUInteger)12, address.length)],
            [address substringFromIndex:address.length - MIN((NSUInteger)8, address.length)]];
        [self.accountMenu.itemArray[index] setTitle:[NSString stringWithFormat:@"%@ %lu · %@",
            NIREnglish() ? @"Wallet" : @"Кошелёк", (unsigned long)(index + 1), shortAddress]];
    }
    for (NSUInteger index = 0; index < MIN(self.backups.count, self.backupMenu.numberOfItems); index++) {
        NSString *address = self.backups[index][@"address"];
        [self.backupMenu.itemArray[index] setTitle:[NSString stringWithFormat:@"%@ %lu · %@…%@",
            NIREnglish() ? @"Backup" : @"Копия", (unsigned long)(index + 1),
            [address substringToIndex:MIN((NSUInteger)12, address.length)],
            [address substringFromIndex:address.length - MIN((NSUInteger)8, address.length)]]];
    }
}

- (void)changeLanguage:(id)sender {
    NIRSetEnglish(self.languageMenu.indexOfSelectedItem == 1);
    [self refresh];
}

- (void)chooseFile {
    if (![[self mode] isEqualToString:@"restore"]) return;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = NO;
    panel.prompt = NIRTranslate(@"Выбрать");
    panel.message = NIRTranslate(@"Выберите резервную копию NIR");
    NSString *folder = [[NSHomeDirectory() stringByAppendingPathComponent:
        @"Library/Application Support/NIR Wallet"] stringByAppendingPathComponent:@"Backups"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:folder]) {
        panel.directoryURL = [NSURL fileURLWithPath:folder isDirectory:YES];
    }
    if ([panel runModal] == NSModalResponseOK) self.selectedPath = panel.URL.path;
    [self refresh];
}

- (void)refresh {
    BOOL creation = [[self mode] isEqualToString:@"create"];
    BOOL opening = [[self mode] isEqualToString:@"open"];
    BOOL restoring = !creation && !opening;
    [self.window setContentSize:NSMakeSize(390, opening ? 580 : (creation ? 640 : 780))];
    self.languageMenu.frame = NSMakeRect(278, (opening ? 580 : (creation ? 640 : 780)) - 42, 84, 30);
    self.logo.frame = NSMakeRect(163, opening ? 440 : (creation ? 522 : 655), 64, 64);
    self.titleLabel.frame = NSMakeRect(28, opening ? 387 : (creation ? 468 : 606), 334, 40);
    self.titleLabel.stringValue = opening ? @"С возвращением!" :
        (creation ? (self.createOnly ? @"Новый адрес NIR" : @"Создайте кошелёк") :
         @"Восстановление");
    self.subtitleLabel.frame = NSMakeRect(28, opening ? 359 : (creation ? 440 : 577), 334, 24);
    self.subtitleLabel.stringValue = @"NIR Wallet · локальная тестовая сеть";
    self.modes.hidden = YES;
    self.back.hidden = opening || self.createOnly || (creation && self.wallets.count == 0);
    self.back.frame = NSMakeRect(23, restoring ? 730 : 588, 95, 28);
    self.createLink.hidden = !opening;
    self.restoreLink.hidden = !opening;
    self.createLink.frame = NSMakeRect(28, 22, 156, 28);
    self.restoreLink.frame = NSMakeRect(206, 22, 156, 28);
    self.renewButton.hidden = !opening || self.createOnly || self.wallets.count == 0;
    self.renewButton.frame = NSMakeRect(28, 250, 334, 24);
    self.pathLabel.frame = NSMakeRect(28, 228, 334, 20);
    self.accountMenu.frame = NSMakeRect(28, 185, 334, 38);
    self.passwordLabel.frame = NSMakeRect(28, restoring ? 335 : 353, 334, 20);
    self.password.frame = NSMakeRect(28, restoring ? 295 : 313, 334, 36);
    self.secondLabel.frame = NSMakeRect(28, restoring ? 252 : 276, 334, 20);
    self.confirmation.frame = NSMakeRect(28, restoring ? 212 : 236, 334, 36);
    self.recoveryLabel.frame = NSMakeRect(28, 418, 334, 20);
    self.recoveryCode.frame = NSMakeRect(28, 378, 334, 36);
    self.backupLabel.frame = NSMakeRect(28, 505, 334, 20);
    self.backupMenu.frame = NSMakeRect(28, 466, 210, 36);
    self.importBackup.frame = NSMakeRect(245, 466, 117, 36);
    self.addressLabel.frame = NSMakeRect(28, 170, 334, 20);
    self.address.frame = NSMakeRect(28, 130, 334, 36);
    self.hint.frame = NSMakeRect(28, opening ? 142 : 169, 334, opening ? 32 : 45);
    self.hint.alignment = NSTextAlignmentCenter;
    self.action.frame = NSMakeRect(28, restoring ? 48 : (opening ? 78 : 99), 334, 46);
    self.backupLabel.hidden = !restoring;
    self.backupMenu.hidden = !restoring || self.backups.count == 0;
    self.importBackup.hidden = !restoring;
    self.passwordLabel.hidden = NO;
    self.secondLabel.hidden = opening;
    self.secondLabel.stringValue = creation ? @"Повторите пароль" : @"Повторите новый пароль";
    self.passwordLabel.stringValue = [[self mode] isEqualToString:@"restore"] ? @"Новый пароль" : @"Пароль";
    self.recoveryLabel.hidden = ![[self mode] isEqualToString:@"restore"];
    self.recoveryCode.hidden = self.recoveryLabel.hidden;
    self.password.hidden = NO;
    self.password.frame = opening ? NSMakeRect(28, 281, 334, 36) : self.password.frame;
    self.passwordLabel.frame = opening ? NSMakeRect(28, 321, 334, 20) : self.passwordLabel.frame;
    self.password.placeholderString = opening ? @"Введите пароль кошелька" : @"От 12 символов";
    self.confirmation.hidden = opening;
    self.address.hidden = ![[self mode] isEqualToString:@"restore"];
    self.addressLabel.hidden = self.address.hidden;
    self.pathLabel.hidden = creation || !opening;
    self.pathLabel.stringValue = self.wallets.count ? @"Ваш адрес" : @"На этом Mac ещё нет кошелька";
    self.accountMenu.hidden = !opening || self.wallets.count == 0;
    self.action.title = creation ? @"Создать кошелёк" :
        (opening ? @"Открыть NIR Wallet" : @"Восстановить кошелёк");
    self.action.attributedTitle = [[NSAttributedString alloc] initWithString:self.action.title
        attributes:@{NSForegroundColorAttributeName:NSColor.whiteColor,
                     NSFontAttributeName:[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold]}];
    self.hint.hidden = restoring;
    self.hint.stringValue = creation ?
        @"Код восстановления покажем после создания. Сохраните его отдельно." :
        (opening ? (self.wallets.count ? @"Пароль откроет выбранный кошелёк. Для операций он потребуется снова." :
            @"Создайте кошелёк, чтобы начать работу.") :
         @"Нужны копия, код восстановления и ранее записанный адрес.");
    [self localizeControls];
}

- (void)openMode:(id)sender {
    self.modes.selectedSegment = 1;
    [self changeMode:sender];
}

- (void)createMode:(id)sender {
    self.modes.selectedSegment = 0;
    [self changeMode:sender];
}

- (void)restoreMode:(id)sender {
    self.modes.selectedSegment = 2;
    [self changeMode:sender];
}

- (void)selectBackup:(id)sender {
    NSInteger index = self.backupMenu.indexOfSelectedItem;
    if (index < 0 || index >= (NSInteger)self.backups.count) return;
    NSDictionary *backup = self.backups[(NSUInteger)index];
    self.selectedPath = backup[@"path"];
    self.address.stringValue = backup[@"address"];
}

- (void)importBackup:(id)sender {
    self.selectedPath = nil;
    self.address.stringValue = @"";
    [self chooseFile];
}

- (void)selectAccount:(id)sender {
    NSInteger index = self.accountMenu.indexOfSelectedItem;
    self.selectedPath = index >= 0 && index < (NSInteger)self.wallets.count ?
        self.wallets[(NSUInteger)index][@"path"] : nil;
}

- (void)changeMode:(id)sender {
    self.selectedPath = [[self mode] isEqualToString:@"open"] && self.wallets.count ?
        self.wallets[0][@"path"] : nil;
    if (self.selectedPath) [self.accountMenu selectItemAtIndex:0];
    if ([[self mode] isEqualToString:@"restore"] && self.backups.count) {
        [self.backupMenu selectItemAtIndex:0];
        [self selectBackup:nil];
    }
    self.password.stringValue = @"";
    self.confirmation.stringValue = @"";
    if (![[self mode] isEqualToString:@"restore"]) self.address.stringValue = @"";
    self.recoveryCode.stringValue = @"";
    [self refresh];
}

- (void)submit:(id)sender {
    NSString *mode = [self mode];
    if ([mode isEqualToString:@"open"] && !self.selectedPath) {
        [self showError:@"На этом Mac нет сохранённого кошелька. Выберите «Создать»."];
        return;
    }
    if ([mode isEqualToString:@"open"] && self.password.stringValue.length == 0) {
        [self showError:@"Введите пароль выбранного кошелька."];
        return;
    }
    if ([mode isEqualToString:@"restore"] && !self.selectedPath) {
        [self showError:@"Выберите копию из списка или нажмите «Другой файл…»."];
        return;
    }
    if (![mode isEqualToString:@"open"]) {
        if (self.password.stringValue.length < 12) {
            [self showError:@"Пароль слишком короткий: нужно от 12 символов."];
            return;
        }
        if (![self.password.stringValue isEqualToString:self.confirmation.stringValue]) {
            [self showError:@"Пароли не совпадают. Проверьте ввод."];
            return;
        }
    }
    if ([mode isEqualToString:@"restore"] && self.address.stringValue.length == 0) {
        [self showError:@"Введите полный адрес, записанный при создании кошелька."];
        return;
    }
    if ([mode isEqualToString:@"restore"] && self.recoveryCode.stringValue.length == 0) {
        [self showError:@"Введите код восстановления."];
        return;
    }
    NSMutableDictionary *result = [@{@"mode": mode} mutableCopy];
    if ([mode isEqualToString:@"create"]) result[@"password"] = self.password.stringValue;
    if ([mode isEqualToString:@"open"]) result[@"password"] = self.password.stringValue;
    if (self.selectedPath) result[@"path"] = self.selectedPath;
    if ([mode isEqualToString:@"restore"]) {
        result[@"address"] = self.address.stringValue;
        result[@"recoveryCode"] = self.recoveryCode.stringValue;
        result[@"newPassword"] = self.password.stringValue;
    }
    [self submitResult:result];
}

- (void)renewCode:(id)sender {
    if (!self.selectedPath || self.password.stringValue.length == 0) {
        [self showError:@"Выберите кошелёк и введите его пароль."];
        return;
    }
#if !defined(NIR_ONBOARDING_SMOKE_RENEW_TEST)
    NSAlert *warning = [NSAlert new];
    warning.messageText = NIRTranslate(@"Создать новый код восстановления?");
    warning.informativeText = NIRTranslate(@"Понадобится сохранить новую резервную копию отдельно от нового кода. Старые копия и код продолжат работать. Если они могли попасть к посторонним, создайте новый адрес и переведите на него средства.");
    [warning addButtonWithTitle:NIRTranslate(@"Продолжить")];
    [warning addButtonWithTitle:NIRTranslate(@"Отмена")];
    if ([warning runModal] != NSAlertFirstButtonReturn) return;
#endif
    [self submitResult:@{ @"mode": @"renew", @"path": self.selectedPath,
                          @"password": self.password.stringValue }];
}

- (void)submitResult:(NSDictionary *)result {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    if (!bytes) exit(1);
    fwrite(bytes.bytes, 1, bytes.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    self.submitted = YES;
    [NSApp terminate:nil];
}

- (void)showError:(NSString *)message {
    NSAlert *alert = [NSAlert new];
    alert.messageText = NIRTranslate(@"Проверьте данные");
    alert.informativeText = NIRTranslate(message);
    [alert runModal];
}

- (void)cancel:(id)sender { exit(2); }
- (void)windowWillClose:(NSNotification *)notification { if (!self.submitted) exit(2); }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
#ifdef NIR_ONBOARDING_LOCALE_SMOKE_TEST
        CFPropertyListRef previous = CFPreferencesCopyAppValue(CFSTR("language"), NIRPreferenceDomain);
        NIRSetEnglish(YES);
        if (!NIREnglish() || ![NIRTranslate(@"Код восстановления") isEqualToString:@"Recovery code"] ||
            ![NIRTranslate(@"Копия остаётся на том же диске") isEqualToString:@"Backup remains on the same disk"]) return 20;
        NIRSetEnglish(NO);
        if (NIREnglish() || ![NIRTranslate(@"Recovery code") isEqualToString:@"Код восстановления"]) return 21;
        CFPreferencesSetAppValue(CFSTR("language"), previous, NIRPreferenceDomain);
        CFPreferencesAppSynchronize(NIRPreferenceDomain);
        if (previous) CFRelease(previous);
        return 0;
#endif
        if (argc == 2 && strcmp(argv[1], "--show-pairing") == 0) {
            NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
            NSString *code = [payload isKindOfClass:NSDictionary.class] ? payload[@"code"] : nil;
            if (![code isKindOfClass:NSString.class] || code.length != 8) return 1;
            for (NSUInteger index = 0; index < code.length; index++) {
                if ([code characterAtIndex:index] < '0' || [code characterAtIndex:index] > '9') return 1;
            }
            NSApplication *app = [NSApplication sharedApplication];
            [app setActivationPolicy:NSApplicationActivationPolicyRegular];
            NSAlert *alert = [NSAlert new];
            alert.messageText = NIRTranslate(@"Подключите кошелёк");
            alert.informativeText = NIRTranslate(@"Введите эти 8 цифр в окне браузера. Это не код восстановления. Код действует 10 минут.");
            NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 250, 42)];
            field.stringValue = code;
            field.editable = NO;
            field.selectable = YES;
            field.alignment = NSTextAlignmentCenter;
            field.font = [NSFont monospacedDigitSystemFontOfSize:28 weight:NSFontWeightMedium];
            alert.accessoryView = field;
            [alert addButtonWithTitle:NIRTranslate(@"Готово")];
            [alert addButtonWithTitle:NIRTranslate(@"Копировать код")];
            // Safari is opened immediately before this helper. Keep the short-lived
            // pairing prompt above that browser window, including when Safari has
            // an in-page connection dialog open.
            NSWindow *pairingWindow = alert.window;
            pairingWindow.level = NSFloatingWindowLevel;
            pairingWindow.collectionBehavior |= NSWindowCollectionBehaviorMoveToActiveSpace;
            [pairingWindow orderFrontRegardless];
            [app activateIgnoringOtherApps:YES];
            [pairingWindow makeKeyAndOrderFront:nil];
            // NSAlert creates its modal session only inside runModal. Activate
            // again from that event loop so Safari cannot reclaim focus first.
            dispatch_async(dispatch_get_main_queue(), ^{
                [[NSRunningApplication currentApplication]
                    activateWithOptions:0];
                [pairingWindow makeKeyAndOrderFront:nil];
                [pairingWindow orderFrontRegardless];
            });
            while (YES) {
                NSModalResponse choice = [alert runModal];
                if (choice == NSAlertFirstButtonReturn) break;
                if (choice == NSAlertSecondButtonReturn) {
                    NSPasteboard *clipboard = [NSPasteboard generalPasteboard];
                    [clipboard clearContents];
                    [clipboard setString:code forType:NSPasteboardTypeString];
                }
            }
            return 0;
        }
        if (argc == 2 && strcmp(argv[1], "--show-secret") == 0) {
            NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
            NSString *kind = [payload isKindOfClass:NSDictionary.class] ? payload[@"kind"] : nil;
            NSString *secret = [payload isKindOfClass:NSDictionary.class] ? payload[@"secret"] : nil;
            NSString *backupPath = [payload isKindOfClass:NSDictionary.class] ? payload[@"backupPath"] : nil;
            if (![secret isKindOfClass:NSString.class] || secret.length == 0 ||
                ![@[@"recovery", @"private-key"] containsObject:kind]) return 1;
            if (backupPath && (![backupPath isKindOfClass:NSString.class] ||
                ![backupPath hasPrefix:@"/"])) return 1;
            NSApplication *app = [NSApplication sharedApplication];
            [app setActivationPolicy:NSApplicationActivationPolicyRegular];
            NSAlert *alert = [NSAlert new];
            BOOL recovery = [kind isEqualToString:@"recovery"];
            alert.messageText = NIRTranslate(recovery ? @"Код восстановления" : @"Приватный ключ");
            alert.informativeText = NIRTranslate(recovery ?
                @"Для этого адреса нужны И код, И зашифрованная копия. Один код не спасёт при потере Mac. Сохраните копию в выбранное место, предпочтительно на отдельный носитель, а код храните отдельно. Каждый новый адрес требует своей копии. Не отправляйте их никому." :
                @"Это полный приватный ключ. Любой, кто его увидит, сможет использовать этот адрес. Показывайте и копируйте его только в безопасном месте.");
            NSString *shown = secret;
            if (recovery) {
                NSArray *groups = [secret componentsSeparatedByString:@"-"];
                if (groups.count != 8) return 1;
                shown = [NSString stringWithFormat:@"%@\n%@",
                    [[groups subarrayWithRange:NSMakeRange(0, 4)] componentsJoinedByString:@"-"],
                    [[groups subarrayWithRange:NSMakeRange(4, 4)] componentsJoinedByString:@"-"]];
            }
            NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 470, recovery ? 88 : 155)];
            scroll.hasVerticalScroller = YES;
            scroll.borderType = NSBezelBorder;
            NSTextView *view = [[NSTextView alloc] initWithFrame:scroll.bounds];
            view.string = shown;
            view.editable = NO;
            view.selectable = YES;
            view.font = [NSFont monospacedSystemFontOfSize:recovery ? 15 : 13 weight:NSFontWeightRegular];
            view.textContainer.widthTracksTextView = YES;
            scroll.documentView = view;
            alert.accessoryView = scroll;
            [alert addButtonWithTitle:NIRTranslate(recovery ? @"Сохранить копию" : @"Готово")];
            [alert addButtonWithTitle:NIRTranslate(@"Копировать")];
            if (recovery) [alert addButtonWithTitle:NIRTranslate(@"Отложить настройку")];
            if (recovery && !backupPath) return 1;
            [app activateIgnoringOtherApps:YES];
            while (YES) {
                NSModalResponse choice = [alert runModal];
                if (choice == NSModalResponseCancel && recovery) return 2;
                if (choice == NSAlertFirstButtonReturn && !recovery) break;
                if (choice == NSAlertSecondButtonReturn) {
                    NSPasteboard *clipboard = [NSPasteboard generalPasteboard];
                    [clipboard clearContents];
                    [clipboard setString:secret forType:NSPasteboardTypeString];
                } else if (choice == NSAlertThirdButtonReturn && recovery) {
                    // The vault already exists. Do not emit a success receipt or
                    // launch it as a completed wallet without an exported copy.
                    return 2;
                } else if (choice == NSAlertFirstButtonReturn && recovery) {
                    NSSavePanel *panel = [NSSavePanel savePanel];
                    panel.nameFieldStringValue = @"NIR-address-recovery.nirvault.json";
                    panel.prompt = NIRTranslate(@"Сохранить копию");
                    if ([panel runModal] == NSModalResponseOK) {
                        NSData *backup = [NSData dataWithContentsOfFile:backupPath];
                        NSString *destination = panel.URL.path;
                        struct stat sourceInfo, directoryInfo;
                        BOOL sameDisk = destination &&
                            stat(backupPath.fileSystemRepresentation, &sourceInfo) == 0 &&
                            stat(destination.stringByDeletingLastPathComponent.fileSystemRepresentation,
                                &directoryInfo) == 0 && sourceInfo.st_dev == directoryInfo.st_dev;
                        if (sameDisk) {
                            NSAlert *warning = [NSAlert new];
                            warning.messageText = NIRTranslate(@"Копия остаётся на том же диске");
                            warning.informativeText = NIRTranslate(@"При потере или поломке этого Mac код без копии не восстановит адрес. Лучше выбрать отдельный носитель. Приложение не может проверить, где физически находится выбранное хранилище.");
                            [warning addButtonWithTitle:NIRTranslate(@"Выбрать другое место")];
                            [warning addButtonWithTitle:NIRTranslate(@"Сохранить всё равно")];
                            if ([warning runModal] != NSAlertSecondButtonReturn) continue;
                        }
                        int descriptor = backup && backup.length >= 2 && backup.length <= 64 * 1024 &&
                            destination ? open(destination.fileSystemRepresentation,
                                O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) : -1;
                        BOOL saved = descriptor >= 0;
                        if (descriptor >= 0) {
                            const unsigned char *bytes = backup.bytes;
                            NSUInteger offset = 0;
                            while (saved && offset < backup.length) {
                                ssize_t count = write(descriptor, bytes + offset, backup.length - offset);
                                if (count > 0) offset += (NSUInteger)count;
                                else if (count < 0 && errno == EINTR) continue;
                                else saved = NO;
                            }
                            if (saved && fsync(descriptor) != 0) saved = NO;
                            if (saved) {
                                struct stat ownFile;
                                if (fstat(descriptor, &ownFile) != 0 || !S_ISREG(ownFile.st_mode) ||
                                    ownFile.st_nlink != 1 || ownFile.st_size != (off_t)backup.length) saved = NO;
                                if (saved) {
                                    NSMutableData *written = [NSMutableData dataWithLength:backup.length];
                                    NSUInteger readOffset = 0;
                                    while (saved && readOffset < backup.length) {
                                        ssize_t count = pread(descriptor,
                                            (unsigned char *)written.mutableBytes + readOffset,
                                            backup.length - readOffset, (off_t)readOffset);
                                        if (count > 0) readOffset += (NSUInteger)count;
                                        else if (count < 0 && errno == EINTR) continue;
                                        else saved = NO;
                                    }
                                    if (saved && ![written isEqualToData:backup]) saved = NO;
                                }
                            }
                            if (close(descriptor) != 0) saved = NO;
                        }
                        if (!saved) {
                            NSAlert *status = [NSAlert new];
                            status.messageText = NIRTranslate(@"Не удалось сохранить копию");
                            status.informativeText = NIRTranslate(@"Выберите новое имя в доступной папке и повторите. Неудачный частичный файл может остаться — не используйте его как копию. Существующие файлы не заменяются.");
                            [status runModal];
                        }
                        if (saved) {
                            NSData *confirmation = [NSJSONSerialization dataWithJSONObject:@{ @"backupExported": @YES,
                                @"backupPath": destination }
                                options:0 error:nil];
                            if (!confirmation) return 1;
                            fwrite(confirmation.bytes, 1, confirmation.length, stdout);
                            fputc('\n', stdout);
                            fflush(stdout);
                            break;
                        }
                    } else return 2;
                }
            }
            return 0;
        }
        NSApplication *app = [NSApplication sharedApplication];
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        NSDictionary *payload = input.length ? [NSJSONSerialization JSONObjectWithData:input options:0 error:nil] : nil;
        NSArray *wallets = [payload isKindOfClass:NSDictionary.class] ? payload[@"wallets"] : nil;
        NSArray *backups = [payload isKindOfClass:NSDictionary.class] ? payload[@"backups"] : nil;
        NSNumber *createOnly = [payload isKindOfClass:NSDictionary.class] ? payload[@"createOnly"] : nil;
        NSString *preferredPath = [payload isKindOfClass:NSDictionary.class] ? payload[@"preferredPath"] : nil;
        if (wallets && ![wallets isKindOfClass:NSArray.class]) return 1;
        if (backups && ![backups isKindOfClass:NSArray.class]) return 1;
        if (preferredPath && ![preferredPath isKindOfClass:NSString.class]) return 1;
        for (id wallet in wallets) {
            if (![wallet isKindOfClass:NSDictionary.class] ||
                ![wallet[@"address"] isKindOfClass:NSString.class] ||
                ![wallet[@"path"] isKindOfClass:NSString.class]) return 1;
        }
        for (id backup in backups) {
            if (![backup isKindOfClass:NSDictionary.class] ||
                ![backup[@"address"] isKindOfClass:NSString.class] ||
                ![backup[@"path"] isKindOfClass:NSString.class]) return 1;
        }
        NIRSetup *delegate = [NIRSetup new];
        delegate.wallets = wallets ?: @[];
        delegate.preferredPath = preferredPath;
        delegate.backups = backups ?: @[];
        delegate.createOnly = [createOnly isKindOfClass:NSNumber.class] && createOnly.boolValue;
        app.delegate = delegate;
#ifdef NIR_ONBOARDING_SMOKE_TEST
        [delegate applicationDidFinishLaunching:nil];
        delegate.password.stringValue = @"test-only-123";
        delegate.confirmation.stringValue = @"test-only-123";
        [delegate submit:nil];
#elif defined(NIR_ONBOARDING_SMOKE_RESTORE_TEST)
        [delegate applicationDidFinishLaunching:nil];
        delegate.modes.selectedSegment = 2;
        delegate.selectedPath = @"/tmp/test-backup.nirvault.json";
        [delegate refresh];
        delegate.password.stringValue = @"new-test-123";
        delegate.confirmation.stringValue = @"new-test-123";
        delegate.recoveryCode.stringValue = @"ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE";
        delegate.address.stringValue = [@"nir1" stringByAppendingString:[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0]];
        [delegate submit:nil];
#elif defined(NIR_ONBOARDING_SMOKE_OPEN_TEST)
        [delegate applicationDidFinishLaunching:nil];
        [delegate refresh];
        delegate.password.stringValue = @"selected-account-test-password";
        [delegate submit:nil];
#elif defined(NIR_ONBOARDING_SMOKE_RENEW_TEST)
        [delegate applicationDidFinishLaunching:nil];
        [delegate refresh];
        delegate.password.stringValue = @"selected-account-test-password";
        [delegate renewCode:nil];
#else
        [app run];
#endif
    }
    return 0;
}
