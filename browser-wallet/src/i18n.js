// UI-only translations. BIP39 words, wallet metadata and encrypted profiles are never translated.
// Russian text remains in the HTML as a safe default if JavaScript does not load.
const english = {
  "header b": "TEST",
  ".notice": "Local test version · no real funds",
  "#welcome h1": "Your NIR starts here",
  "#welcome .hero p": "A wallet in your browser. Your password and recovery phrase stay on this device.",
  "#start-create": "Create wallet",
  "#start-restore": "I have a recovery phrase",
  "[data-back]": "← Back",
  "#create h1": "Create a password",
  "#create > p": "This password unlocks the wallet only in this browser. On another device you will need your recovery phrase.",
  "#create-form label:nth-child(1)": "Password",
  "#create-form label:nth-child(2)": "Confirm password",
  "#create-form button": "Continue",
  "#backup h1": "Save your 24 words",
  "#backup > p:not(.warning)": "Write them down in order and keep them separate. Anyone with this phrase can control the wallet. We cannot recover it for you.",
  "#backup .warning": "If you switch windows or are inactive for 5 minutes, the phrase disappears. You will need to start again.",
  "#copy-phrase": "Copy phrase",
  "#backup-next": "I saved the words",
  "#confirm h1": "Verify your phrase",
  "#confirm > p:not(.warning)": "Enter the requested words to confirm you saved them correctly.",
  "#confirm .warning": "Switching windows or being inactive for 5 minutes restarts verification.",
  "#confirm-form button": "Create wallet",
  "#restore h1": "Restore wallet",
  "#restore > p:not(.warning):nth-of-type(1)": "Enter all 24 words in the correct order. Set a new password on this device.",
  "#restore .warning": "Switching windows or being inactive for 5 minutes clears the entered words.",
  "#restore > p:not(.warning):nth-of-type(3)": "The first 16 addresses from this phrase will be available. Select yours from the address list.",
  "#restore-form label:nth-child(1)": "Secret recovery phrase",
  "#restore-form label:nth-child(2)": "New password",
  "#restore-form label:nth-child(3)": "Confirm password",
  "#restore-form button": "Restore",
  "#unlock h1": "Welcome back!",
  "#unlock .hero p": "Enter your password to unlock NIR Wallet.",
  "#unlock-form label": "Password",
  "#unlock-form button": "Unlock",
  "#forgot-password": "Forgot password? Restore with phrase",
  "#open-accounts@aria-label": "Select address",
  "#copy-address@title": "Copy address",
  ".balance p": "Network balance",
  ".balance small": "Not verified by this extension",
  "#observer-report h2": "Local process report",
  "#observer-report .report-lead": "The local observer reported ",
  "#observer-report .report-middle": " test NIR at height ",
  "#observer-report .report-tail": ". The extension did not verify signatures independently; network freshness and spendable funds are unconfirmed. This is not a mining reward.",
  "#receive span": "Receive",
  "#send span": "Send",
  "#mine span": "Mining",
  "#home .card h2": "Security",
  "#home .card:not(.observer-report) p": "You can copy your address now. Transfers and mining are unavailable. The local observer report is not independent extension verification or a current network balance.",
  "#nav-home": "Home",
  "#nav-settings": "Settings",
  "#accounts h1": "Your addresses",
  "#add-account": "+ Add address",
  "#settings h1": "Settings",
  "#settings .observer-card h2": "Local observer · engineering preview",
  "#settings .observer-card > p:nth-of-type(1)": "For experienced testnet operators. The observer must be started separately and bound to this address, extension origin and reviewed genesis. It cannot access your phrase or sign. No public network or real funds exist.",
  "#settings .observer-card > p:nth-of-type(2)": "Extension origin:",
  "#observer-form label:nth-child(1)": "Observer address",
  "#observer-form label:nth-child(2)": "Separate observer token",
  "#observer-form label:nth-child(3)": "Network ID",
  "#observer-form label:nth-child(4)": "Genesis hash from a trusted source",
  "#observer-form button": "Get local report",
  "#settings .observer-card > p:nth-of-type(3)": "The token lives only in this open window's memory. A separate process must be set up manually with a trusted genesis; automatic installation is unavailable. Its response does not prove network freshness.",
  "#settings .card:not(.observer-card) h2": "Recovery phrase",
  "#settings .card:not(.observer-card) p": "Enter your password to view it again. Never show these words to anyone.",
  "#show-phrase-form": "Show phrase",
  "#lock-wallet": "Lock wallet",
  "#reveal h1": "Show phrase",
  "#reveal > p": "Make sure nobody can see your screen. The phrase gives full access to your addresses.",
  "#reveal-form label": "Password",
  "#reveal-form button": "Show",
  "#copy-revealed": "Copy phrase",
  "#receive-view h1": "Receive NIR",
  "#receive-view > p:not(.warning)": "Selected account address:",
  "#copy-full-address": "Copy address",
  "#receive-view .warning": "There is no public NIR network yet. Do not send real funds."
};

const messages = {
  "Сеанс кошелька завершён": "Wallet session has ended",
  "Кошелёк заблокирован": "Wallet is locked",
  "Не удалось выполнить действие": "Could not complete the action",
  "Не удалось сохранить язык интерфейса": "Could not save the interface language",
  "Нужен адрес локального наблюдателя": "Enter the local observer address",
  "Наблюдатель должен работать на 127.0.0.1": "Observer must run on 127.0.0.1",
  "Неверный токен наблюдателя": "Invalid observer token",
  "Проверьте идентификатор сети и genesis": "Check the network ID and genesis hash",
  "Доказательство баланса не совпадает с адресом или сетью": "Balance proof does not match this address or network",
  "Локальный наблюдатель не подтвердил баланс": "Local observer did not verify the balance",
  "Пароли не совпадают": "Passwords do not match",
  "Подождите завершения текущего действия": "Wait for the current action to finish",
  "На этом устройстве уже есть кошелёк": "A wallet already exists on this device",
  "Создание кошелька прервано": "Wallet creation was interrupted",
  "Это фраза другого кошелька. Существующий кошелёк не заменён.": "This phrase belongs to a different wallet. The existing wallet was not replaced.",
  "На устройстве нет кошелька": "No wallet exists on this device",
  "Достигнут предел 16 адресов": "The limit of 16 addresses has been reached",
  "Не показывайте эти слова никому.": "Never show these words to anyone.",
  "Сначала введите пароль": "Enter your password first",
  "Данные кошелька повреждены. Обратитесь за помощью, не удаляйте расширение.": "Wallet data is damaged. Seek help; do not remove the extension.",
  "Пароль: минимум 12 символов, включая 4 разных": "Password: at least 12 characters, including 4 distinct ones",
  "Нужны 24 слова восстановления": "A 24-word recovery phrase is required",
  "Нужны 24 правильных английских слова": "Enter 24 valid English recovery words",
  "Контрольная сумма фразы неверна": "The phrase checksum is invalid",
  "Неверный пароль или повреждены данные кошелька": "Wrong password or damaged wallet data",
  "Invalid wallet data": "Invalid wallet data",
  "Invalid entropy": "Invalid entropy",
  "Invalid account index": "Invalid account index",
  "NIR word list is invalid": "NIR word list is invalid"
};

const original = new Map();
export const staticTranslationTargets = Object.freeze(Object.keys(english));

function textNode(element) {
  return [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) ?? element;
}

export function applyStaticLocale(locale) {
  document.documentElement.lang = locale;
  for (const [target, translation] of Object.entries(english)) {
    const [selector, attribute] = target.split("@");
    const elements = document.querySelectorAll(selector);
    if (!elements.length) throw new Error(`Missing translation target: ${target}`);
    for (const element of elements) {
      const node = attribute ? element : textNode(element);
      if (!original.has(node)) original.set(node, attribute ? element.getAttribute(attribute) : node.textContent);
      const value = locale === "en" ? translation : original.get(node);
      if (attribute) element.setAttribute(attribute, value);
      else node.textContent = value;
    }
  }
  for (const [name, code] of [["ru", "Русский"], ["en", "English"]]) {
    const button = document.querySelector(`#locale-${name}`);
    button.setAttribute("aria-pressed", String(locale === name));
    button.setAttribute("aria-label", code);
  }
}

export function localize(message, locale) {
  if (locale !== "en") return message;
  if (messages[message]) return messages[message];
  let match = /^Адрес (\d+)( ✓)?$/.exec(message);
  if (match) return `Address ${match[1]}${match[2] ?? ""}`;
  match = /^Слово № (\d+)$/.exec(message);
  if (match) return `Word #${match[1]}`;
  match = /^Проверьте слово № (\d+)$/.exec(message);
  if (match) return `Check word #${match[1]}`;
  match = /^(Фраза|Адрес) скопирован\. Очистите буфер обмена после использования\.$/.exec(message);
  if (match) return `${match[1] === "Фраза" ? "Phrase" : "Address"} copied. Clear your clipboard after use.`;
  return message;
}

function isKnownUiMessage(message) {
  return Object.hasOwn(messages, message) || /^Адрес \d+( ✓)?$/.test(message) ||
    /^Слово № \d+$/.test(message) || /^Проверьте слово № \d+$/.test(message) ||
    /^(Фраза|Адрес) скопирован\. Очистите буфер обмена после использования\.$/.test(message);
}

export function safeUiError(error) {
  return error instanceof Error && isKnownUiMessage(error.message) ? error.message : "Не удалось выполнить действие";
}
