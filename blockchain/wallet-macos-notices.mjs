// Text for the native setup process after the onboarding window has closed.
// Keep the language bound to the user's explicit wizard choice, not an
// inferred system locale or a browser-controlled parameter.
export function walletSetupNotice(kind, language, { address, unsafePermissions = false } = {}) {
  if (language !== "ru" && language !== "en") throw new Error("invalid wallet setup language");
  if (kind === "recovery-export") {
    return language === "en" ? {
      title: "Backup verified",
      message: `Restoring this address requires both the encrypted backup and a separate recovery code. Every new address needs its own backup. The app cannot verify that the storage device is physically independent.${unsafePermissions ? " Warning: other users may be able to read the backup at the chosen location; store it somewhere safe." : ""}`,
    } : {
      title: "Резервная копия проверена",
      message: `Для восстановления этого адреса нужны зашифрованная копия и отдельный код. Для каждого нового адреса нужна своя копия. Приложение не подтверждает физическую независимость носителя.${unsafePermissions ? " Внимание: выбранный носитель допускает чтение файла другими пользователями; храните копию в безопасном месте." : ""}`,
    };
  }
  if (kind === "recovery-renewal") {
    return language === "en" ? {
      title: "Backup verified",
      message: `Restoring this address requires both the encrypted backup and a separate recovery code. The old backup and code remain valid. The app cannot verify that the storage device is physically independent.${unsafePermissions ? " Warning: other users may be able to read the backup at the chosen location; store it somewhere safe." : ""}`,
    } : {
      title: "Резервная копия проверена",
      message: `Для восстановления этого адреса нужны зашифрованная копия и отдельный код. Старые копия и код продолжают действовать. Приложение не подтверждает физическую независимость хранилища.${unsafePermissions ? " Внимание: выбранный носитель допускает чтение файла другими пользователями; храните копию в безопасном месте." : ""}`,
    };
  }
  if (kind === "open-failed") {
    return language === "en" ? {
      title: "Could not open wallet",
      message: "Check the password for the selected address. If the password is correct, restore the wallet from its encrypted backup.",
    } : {
      title: "Не удалось открыть кошелёк",
      message: "Проверьте пароль выбранного адреса. Если пароль верен, восстановите кошелёк из резервной копии.",
    };
  }
  if (kind === "incomplete-recovery") {
    if (typeof address !== "string" || !/^nir1[0-9a-f]{64}$/.test(address)) {
      throw new Error("invalid incomplete-recovery address");
    }
    return language === "en" ? {
      title: "Setup did not finish",
      message: `Wallet ${address} was saved, but exporting and verifying its backup did not finish. Open this address with its password and choose “New recovery code”. Do not use the address for funds until you have saved the encrypted backup and a separate code.`,
    } : {
      title: "Настройка не завершена",
      message: `Кошелёк ${address} сохранён, но настройка резервной копии не завершена или не прошла проверку. Откройте этот адрес с паролем и нажмите «Новый код восстановления». Не используйте адрес для средств до сохранения зашифрованной копии и отдельного кода.`,
    };
  }
  throw new Error("unknown wallet setup notice");
}
