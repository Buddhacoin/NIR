// NIR Wallet on Windows and Linux: the same wallet files and bridge as on a
// Mac, with the Mac system windows replaced by NIR's own confirmation windows
// (desktop-dialogs.mjs). Passwords and the 24 words appear only there.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { validPersonalWalletPassword } from "./vault.mjs";
import { walletPublicInfo } from "./wallet-files.mjs";
import { changeLocalTestWalletPassword, listLocalTestWallets } from "./wallet-onboarding.mjs";
import { addLocalSeedAccount, createLocalSeedWallet, hasLocalSeed, restoreLocalSeedWallet,
  revealLocalSeedPhrase } from "./wallet-seed-accounts.mjs";
import { signingSummary } from "./wallet-signing-summary.mjs";

const COPY = {
  ru: {
    cancel: "Отмена", next: "Продолжить", ok: "Понятно",
    welcome: "Добро пожаловать в NIR Wallet",
    welcomeText: "Кошелёк хранит ваши NIR на этом компьютере. У вас уже есть 24 секретных слова от другого NIR Wallet?",
    restore: "Восстановить по 24 словам", create: "Новый кошелёк",
    passwordTitle: "Придумайте пароль",
    passwordText: "Пароль защищает кошелёк на этом компьютере. Он нужен для каждой подписи.\nОт 9 символов, минимум 5 разных, буква и цифра или знак.",
    password: "Пароль", repeat: "Повторите пароль",
    mismatch: "Пароли не совпадают.",
    weak: "Пароль слишком простой: от 9 символов, минимум 5 разных, буква и цифра или знак.",
    phraseTitle: "Ваши 24 секретных слова",
    phraseText: "Запишите слова на бумагу по порядку и храните её дома. Кто знает эти слова, тот владеет всеми монетами кошелька. Не фотографируйте, не копируйте и никому не сообщайте.",
    written: "Я записал(а)",
    checkTitle: "Проверим запись",
    checkText: (a, b) => `Введите слово №${a} и слово №${b} с вашего листа.`,
    word: (n) => `Слово №${n}`,
    checkFailed: "Слова не совпали. Сейчас фраза будет показана ещё раз — сверьте запись.",
    showLater: "Слова можно посмотреть ещё раз: Настройки → «Секретная фраза».",
    restoreTitle: "Восстановление по 24 словам",
    restoreText: "Введите 24 слова через пробел, по порядку, и придумайте пароль для этого компьютера.",
    words: "24 слова",
    restoreFailed: "Слова не подошли. Проверьте написание и порядок.",
    signTitle: "Подтвердите операцию",
    sign: "Подписать", decline: "Отклонить",
    walletPassword: "Пароль кошелька",
    revealTitle: "Показать 24 секретных слова",
    revealText: "Введите пароль кошелька. Убедитесь, что экран никто не видит.",
    show: "Показать",
    wrongPassword: "Неверный пароль.",
    newAccountTitle: "Новый счёт",
    newAccountText: "Новый счёт создаётся из тех же 24 слов и с тем же паролем.",
    create2: "Создать",
    changeTitle: "Сменить пароль",
    changeText: "Изменится только файл кошелька на этом компьютере. Ваши 24 слова остаются прежними.",
    current: "Текущий пароль", fresh: "Новый пароль", freshRepeat: "Повторите новый пароль",
  },
  en: {
    cancel: "Cancel", next: "Continue", ok: "OK",
    welcome: "Welcome to NIR Wallet",
    welcomeText: "The wallet keeps your NIR on this computer. Do you already have 24 secret words from another NIR Wallet?",
    restore: "Restore from 24 words", create: "New wallet",
    passwordTitle: "Choose a password",
    passwordText: "The password protects the wallet on this computer. Every signature needs it.\n9+ characters, at least 5 different, a letter and a digit or symbol.",
    password: "Password", repeat: "Repeat the password",
    mismatch: "The passwords differ.",
    weak: "The password is too simple: 9+ characters, at least 5 different, a letter and a digit or symbol.",
    phraseTitle: "Your 24 secret words",
    phraseText: "Write the words on paper in order and keep it at home. Whoever knows these words owns every coin in the wallet. Do not photograph, copy or share them.",
    written: "I wrote them down",
    checkTitle: "Let's check",
    checkText: (a, b) => `Type word No. ${a} and word No. ${b} from your paper.`,
    word: (n) => `Word No. ${n}`,
    checkFailed: "The words did not match. The phrase will be shown again — check what you wrote.",
    showLater: "You can see the words again: Settings → “Secret phrase”.",
    restoreTitle: "Restore from 24 words",
    restoreText: "Type the 24 words separated by spaces, in order, and choose a password for this computer.",
    words: "24 words",
    restoreFailed: "The words did not fit. Check the spelling and order.",
    signTitle: "Confirm the operation",
    sign: "Sign", decline: "Decline",
    walletPassword: "Wallet password",
    revealTitle: "Show the 24 secret words",
    revealText: "Enter the wallet password. Make sure nobody sees the screen.",
    show: "Show",
    wrongPassword: "Wrong password.",
    newAccountTitle: "New account",
    newAccountText: "A new account comes from the same 24 words and uses the same password.",
    create2: "Create",
    changeTitle: "Change password",
    changeText: "Only the wallet file on this computer changes. Your 24 words stay the same.",
    current: "Current password", fresh: "New password", freshRepeat: "Repeat the new password",
  },
};

export function systemLanguage(env = process.env) {
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "";
  return /^(ru|uk|be|kk)/i.test(locale) ? "ru" : "en";
}

export function createDesktopWalletHost({ dialogs, storageRoot, language = systemLanguage() }) {
  const t = COPY[language === "en" ? "en" : "ru"];
  const ask = (spec, options) => dialogs.ask({ language, ...spec }, options);
  const cancel = { id: "cancel", label: t.cancel };

  async function choosePassword(signal) {
    let error = "";
    for (;;) {
      const answer = await ask({ title: t.passwordTitle, message: t.passwordText, error,
        fields: [{ name: "password", type: "password", label: t.password },
          { name: "repeat", type: "password", label: t.repeat }],
        buttons: [cancel, { id: "next", label: t.next, primary: true }] }, { signal });
      if (answer?.button !== "next") return null;
      if (answer.values.password !== answer.values.repeat) { error = t.mismatch; continue; }
      if (!validPersonalWalletPassword(answer.values.password)) { error = t.weak; continue; }
      return answer.values.password;
    }
  }

  // The words, then two of them asked back; shown again until they match.
  async function showPhrase(phrase, signal) {
    const words = phrase.split(" ");
    for (;;) {
      const shown = await ask({ title: t.phraseTitle, message: t.phraseText, words: [...words],
        buttons: [{ id: "written", label: t.written, primary: true }] }, { signal, width: 640, height: 640 });
      if (shown?.button !== "written") break;
      const first = Math.floor(Math.random() * 24);
      const second = (first + 1 + Math.floor(Math.random() * 23)) % 24;
      const [a, b] = [first, second].sort((x, y) => x - y);
      const check = await ask({ title: t.checkTitle, message: t.checkText(a + 1, b + 1),
        fields: [{ name: "a", type: "text", label: t.word(a + 1) }, { name: "b", type: "text", label: t.word(b + 1) }],
        buttons: [{ id: "check", label: t.next, primary: true }] }, { signal });
      if (check?.button !== "check") break;
      if (check.values.a.trim().toLowerCase() === words[a] && check.values.b.trim().toLowerCase() === words[b]) {
        words.fill("");
        return true;
      }
      await ask({ title: t.checkTitle, message: t.checkFailed, buttons: [{ id: "ok", label: t.ok, primary: true }] },
        { signal });
    }
    words.fill("");
    await ask({ title: t.phraseTitle, message: t.showLater, buttons: [{ id: "ok", label: t.ok, primary: true }] },
      { signal }).catch(() => null);
    return false;
  }

  async function restore(signal) {
    let error = "";
    for (;;) {
      const answer = await ask({ title: t.restoreTitle, message: t.restoreText, error,
        fields: [{ name: "words", type: "words", label: t.words },
          { name: "password", type: "password", label: t.password },
          { name: "repeat", type: "password", label: t.repeat }],
        buttons: [cancel, { id: "restore", label: t.next, primary: true }] }, { signal, width: 600, height: 640 });
      if (answer?.button !== "restore") return null;
      const { words, password, repeat } = answer.values;
      if (password !== repeat) { error = t.mismatch; continue; }
      if (!validPersonalWalletPassword(password)) { error = t.weak; continue; }
      try {
        return restoreLocalSeedWallet({ storageRoot, phrase: words.trim().toLowerCase().split(/\s+/).join(" "),
          password });
      } catch {
        error = t.restoreFailed;
      }
    }
  }

  async function create(signal) {
    const password = await choosePassword(signal);
    if (password === null) return null;
    const created = createLocalSeedWallet({ storageRoot, password });
    await showPhrase(created.phrase, signal);
    created.phrase = "";
    return created;
  }

  async function addAccount(signal) {
    let error = "";
    for (;;) {
      const answer = await ask({ title: t.newAccountTitle, message: t.newAccountText, error,
        fields: [{ name: "password", type: "password", label: t.walletPassword }],
        buttons: [cancel, { id: "create", label: t.create2, primary: true }] }, { signal });
      if (answer?.button !== "create") return null;
      try { return addLocalSeedAccount({ storageRoot, password: answer.values.password }); }
      catch (failure) {
        if (failure?.message !== "wallet password is incorrect") throw failure;
        error = t.wrongPassword;
      }
    }
  }

  return {
    // The wallet to open: the first one on this computer, or a new or
    // restored one on the first start. null means the person closed setup.
    async setup({ signal } = {}) {
      const wallets = listLocalTestWallets(storageRoot);
      if (wallets.length > 0) return { address: wallets[0].address, walletPath: wallets[0].path };
      for (;;) {
        const start = await ask({ title: t.welcome, message: t.welcomeText,
          buttons: [{ id: "restore", label: t.restore }, { id: "create", label: t.create, primary: true }] },
        { signal });
        if (!start) return null;
        const result = start.button === "restore" ? await restore(signal) : await create(signal);
        if (result) return { address: result.address, walletPath: result.walletPath };
      }
    },

    async createAccount() {
      const created = hasLocalSeed(storageRoot) ? await addAccount() : await create();
      if (!created) throw new Error("new account was not created");
      if (walletPublicInfo(created.walletPath).address !== created.address) {
        throw new Error("new wallet identity changed");
      }
      return { address: created.address, path: created.walletPath };
    },

    async authorize(intent, { signal } = {}) {
      const answer = await ask({ title: t.signTitle, message: signingSummary(intent, language),
        fields: [{ name: "password", type: "password", label: t.walletPassword }],
        buttons: [{ id: "decline", label: t.decline }, { id: "sign", label: t.sign, primary: true }] },
      { signal, width: 600, height: 620 });
      if (answer?.button !== "sign" || signal?.aborted) return null;
      return answer.values.password;
    },

    async revealPhrase({ signal }) {
      if (!hasLocalSeed(storageRoot)) return "no-phrase";
      const answer = await ask({ title: t.revealTitle, message: t.revealText,
        fields: [{ name: "password", type: "password", label: t.walletPassword }],
        buttons: [cancel, { id: "show", label: t.show, primary: true }] }, { signal });
      if (answer?.button !== "show" || signal?.aborted) return "cancelled";
      let phrase;
      try { phrase = revealLocalSeedPhrase({ storageRoot, password: answer.values.password }); }
      catch (error) {
        if (error?.message === "wallet password is incorrect") return "wrong-password";
        throw new Error("the secret phrase could not be shown");
      }
      const words = phrase.split(" ");
      phrase = "";
      await ask({ title: t.phraseTitle, message: t.phraseText, words,
        buttons: [{ id: "ok", label: t.ok, primary: true }] }, { signal, width: 640, height: 600 });
      return "shown";
    },

    async passwordChange({ vaultPath, signal }) {
      let error = "";
      for (;;) {
        const answer = await ask({ title: t.changeTitle, message: t.changeText, error,
          fields: [{ name: "current", type: "password", label: t.current },
            { name: "fresh", type: "password", label: t.fresh },
            { name: "repeat", type: "password", label: t.freshRepeat }],
          buttons: [cancel, { id: "change", label: t.next, primary: true }] }, { signal, width: 560, height: 620 });
        if (answer?.button !== "change" || signal?.aborted) return false;
        const { current, fresh, repeat } = answer.values;
        if (fresh !== repeat) { error = t.mismatch; continue; }
        if (!validPersonalWalletPassword(fresh)) { error = t.weak; continue; }
        const before = walletPublicInfo(vaultPath).address;
        try {
          changeLocalTestWalletPassword({ storageRoot, walletPath: vaultPath, oldPassword: current, newPassword: fresh });
        } catch (failure) {
          if (failure?.code === "NIR_WALLET_CURRENT_OPEN_FAILED") { error = t.wrongPassword; continue; }
          throw new Error("password change did not complete");
        }
        if (walletPublicInfo(vaultPath).address !== before) throw new Error("wallet identity changed during password change");
        return true;
      }
    },

    // The person's own names for their accounts, next to the wallets.
    accountNames: {
      read() {
        try {
          const value = JSON.parse(readFileSync(join(storageRoot, "account-names.json"), "utf8"));
          return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        } catch {
          return {};
        }
      },
      write(address, name) {
        const names = { ...this.read(), [address]: name };
        const path = join(storageRoot, "account-names.json");
        writeFileSync(`${path}.tmp`, `${JSON.stringify(names, null, 2)}\n`, { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      },
    },
  };
}
