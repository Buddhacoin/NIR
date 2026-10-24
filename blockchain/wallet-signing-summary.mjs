// What NIR Wallet tells the person before a signature: the same words in the
// Mac system dialog and in the Windows and Linux confirmation window.
export function signingSummary(intent, language = "ru") {
  if (language === "en") return englishSummary(intent);
  return intent.type === "local-iris-run-receipt" ? [
    "Подтвердить адресом хэш локального свидетельства Iris?",
    `Адрес: ${intent.address}`,
    `Nonce запуска: ${intent.nonce}`,
    `SHA-256 свидетельства: ${intent.evidenceDigest}`,
    `Hash пакета: ${intent.bundleHash}`,
    "Подпись привяжет адрес к байтам файла, но не докажет выполнение модели. Не заявка в сеть и не награда.",
    "Подписывайте, только если запускали Iris в Model Lab и сверили адрес и hash.",
  ].join("\n") : intent.type === "local-operator-wallet-link" ? [
    "NIR Model Lab просит подключить этот кошелёк.",
    `Адрес: ${intent.address}`,
    "Награды за майнинг будут приходить на этот адрес. Model Lab узнает только адрес: ни ключ, ни пароль не передаются, монеты не списываются.",
    "Отклоните, если вы не нажимали «Подключить NIR Wallet» в Model Lab.",
  ].join("\n") : intent.type === "name-register" ? [
    `Купить имя ${intent.name}.nir для этого счёта?`,
    `Адрес: ${intent.address}`,
    `Цена: ${intent.price}, один раз. Эти NIR сгорают: их не получает никто, ни создатель, ни сеть.`,
    "Имя остаётся вашим, пока вы сами его не смените. Если у счёта уже есть имя, старое освободится.",
    "Запись займёт около минуты: сначала скрытая заявка, затем само имя.",
  ].join("\n") : intent.type === "name-release" ? [
    "Освободить имя этого счёта?",
    `Адрес: ${intent.address}`,
    "Имя станет свободным, его сможет купить любой. Деньги за имя не возвращаются.",
  ].join("\n") : intent.type === "name-transfer" ? [
    "Отдать имя этого счёта другому адресу?",
    `Ваш адрес: ${intent.address}`,
    `Новый владелец: ${intent.recipient}`,
    "У нового владельца не должно быть своего имени. Отменить передачу нельзя.",
  ].join("\n") : [
    "Подписать операцию NIR?",
    `Тип: ${intent.type ?? "transfer"}`,
    `Сеть: ${intent.networkId}`,
    ...(intent.recipient ? [`Получатель: ${intent.recipient}`] : []),
    ...(intent.amount ? [`Сумма: ${intent.amount} atomic units`] : []),
    `Комиссия: ${intent.fee ?? "по правилам сети"}`,
    `Nonce: ${intent.nonce}`,
    `Запрос: ${intent.requestId}`,
    "Отклоните запрос, если вы его не начинали.",
  ].join("\n");
}

function englishSummary(intent) {
  return intent.type === "local-iris-run-receipt" ? [
    "Confirm the hash of local Iris evidence with this address?",
    `Address: ${intent.address}`,
    `Run nonce: ${intent.nonce}`,
    `Evidence SHA-256: ${intent.evidenceDigest}`,
    `Bundle hash: ${intent.bundleHash}`,
    "The signature binds the address to the file's bytes; it does not prove the model ran. Not a network claim or a reward.",
    "Sign only if you ran Iris in Model Lab and checked the address and hash.",
  ].join("\n") : intent.type === "local-operator-wallet-link" ? [
    "NIR Miner asks to connect this wallet.",
    `Address: ${intent.address}`,
    "Mining rewards will arrive at this address. The miner learns only the address: no key or password is shared, no coins are spent.",
    "Decline if you did not press “Connect NIR Wallet” in NIR Miner.",
  ].join("\n") : intent.type === "name-register" ? [
    `Buy the name ${intent.name}.nir for this account?`,
    `Address: ${intent.address}`,
    `Price: ${intent.price}, once. These NIR are burned: nobody receives them, not the founder, not the network.`,
    "The name stays yours until you change it. If the account already has a name, the old one is released.",
    "Recording takes about a minute: first a hidden claim, then the name itself.",
  ].join("\n") : intent.type === "name-release" ? [
    "Release this account's name?",
    `Address: ${intent.address}`,
    "The name becomes free for anyone to buy. The price paid is not returned.",
  ].join("\n") : intent.type === "name-transfer" ? [
    "Give this account's name to another address?",
    `Your address: ${intent.address}`,
    `New owner: ${intent.recipient}`,
    "The new owner must not have a name of its own. A transfer cannot be undone.",
  ].join("\n") : [
    "Sign a NIR operation?",
    `Type: ${intent.type ?? "transfer"}`,
    `Network: ${intent.networkId}`,
    ...(intent.recipient ? [`Recipient: ${intent.recipient}`] : []),
    ...(intent.amount ? [`Amount: ${intent.amount} atomic units`] : []),
    `Fee: ${intent.fee ?? "by network rules"}`,
    `Nonce: ${intent.nonce}`,
    `Request: ${intent.requestId}`,
    "Decline the request if you did not start it.",
  ].join("\n");
}
