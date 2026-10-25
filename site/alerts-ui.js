// Price alerts, shared by a coin's page and /alerts/: the "new alert" dialog
// (with a coin picker when no coin is given) and browser notifications
// through the service worker /sw.js. Needs common.js.

const alertText = {
  ru: { title: "Уведомление о цене", coin: "Монета", above: "Цена выше", below: "Цена ниже", rise: "Рост за 24 ч", fall: "Падение за 24 ч",
    price: "Цена, $", percent: "Процент, %", repeat: "Повторять каждый раз", now: "Сейчас", save: "Создать уведомление",
    saved: "Готово! Уведомление сработает, когда условие выполнится.", pushAsk: "Включить уведомления в этом браузере",
    pushOn: "Уведомления в этом браузере включены.", pushDenied: "Браузер запретил уведомления: разрешите их в настройках сайта.",
    pushNo: "Этот браузер не умеет получать уведомления. На iPhone добавьте сайт на экран «Домой» (Поделиться → На экран «Домой») и откройте оттуда.",
    pickCoin: "Выберите монету из списка.", badValue: "Введите число больше нуля.", close: "Закрыть", failed: "Не сохранилось. Попробуйте ещё раз.",
    signInFirst: "Войдите через Google, чтобы получать уведомления.", fired: "Сработало уведомление", open: "Открыть" },
  en: { title: "Price alert", coin: "Coin", above: "Price above", below: "Price below", rise: "24h rise", fall: "24h fall",
    price: "Price, $", percent: "Percent, %", repeat: "Repeat every time", now: "Now", save: "Create alert",
    saved: "Done! The alert fires when the condition is met.", pushAsk: "Turn on notifications in this browser",
    pushOn: "Notifications are on in this browser.", pushDenied: "The browser blocked notifications: allow them in the site settings.",
    pushNo: "This browser cannot receive notifications. On iPhone add the site to the Home Screen (Share → Add to Home Screen) and open it from there.",
    pickCoin: "Pick a coin from the list.", badValue: "Enter a number above zero.", close: "Close", failed: "Not saved. Please try again.",
    signInFirst: "Sign in with Google to get alerts.", fired: "An alert fired", open: "Open" },
};
const aT = () => alertText[language];

// --- Browser notifications.
let pushKey = null;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}
async function enablePush() {
  if (!pushSupported()) return "unsupported";
  if (!pushKey) pushKey = (await send("/market/me/alerts", "GET")).data.push?.key;
  if (!pushKey) return "off";
  const registration = await navigator.serviceWorker.register("/sw.js");
  if (await Notification.requestPermission() !== "granted") return "denied";
  await navigator.serviceWorker.ready;
  const raw = Uint8Array.from(atob(pushKey.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  const { endpoint, keys } = subscription.toJSON();
  const { status } = await send("/market/me/push", "POST", { endpoint, keys });
  return status === 201 ? "on" : "off";
}
async function disablePush() {
  const registration = pushSupported() ? await navigator.serviceWorker.getRegistration("/") : null;
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await send("/market/me/push", "DELETE", { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}
// A button that turns notifications on, or a line saying why it cannot.
async function pushControl(node) {
  const state = await pushState();
  if (state === "off") {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "act", textContent: `🔔 ${aT().pushAsk}` });
    button.addEventListener("click", async () => { button.disabled = true; await enablePush(); await pushControl(node); });
    node.replaceChildren(button);
  } else {
    node.replaceChildren(Object.assign(document.createElement("p"), { className: "muted",
      textContent: { on: aT().pushOn, denied: aT().pushDenied, unsupported: aT().pushNo }[state] }));
  }
  return state;
}

// --- The dialog. `coin` is { id, name, symbol, price, change24h, image } or null for a coin picker.
let alertDialog = null;
function openAlertDialog(coin = null, { onSaved = () => {}, overview = () => null } = {}) {
  if (!account.user) {
    if (account.signIn) location.href = signInUrl();
    else alert(aT().signInFirst);
    return;
  }
  alertDialog?.remove();
  let kind = "above";
  let picked = coin;
  const dialog = alertDialog = document.createElement("dialog");
  dialog.className = "pf-dialog";
  const form = document.createElement("form");
  const top = document.createElement("div");
  top.className = "pf-dialog-top";
  const close = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: "✕", ariaLabel: aT().close });
  close.addEventListener("click", () => dialog.close());
  top.append(Object.assign(document.createElement("h2"), { textContent: aT().title }), close);
  const label = (text, field) => {
    const wrap = document.createElement("label");
    wrap.append(Object.assign(document.createElement("span"), { textContent: text }), field);
    return wrap;
  };
  // The coin: fixed on a coin's page, picked from the top coins and search elsewhere.
  const coinBox = document.createElement("span");
  coinBox.className = "pf-coin-pick";
  const coinInput = Object.assign(document.createElement("input"), { autocomplete: "off", placeholder: "Bitcoin, ETH…" });
  const suggest = Object.assign(document.createElement("span"), { className: "suggest", hidden: true });
  coinBox.append(coinInput, suggest);
  const now = document.createElement("p");
  now.className = "muted alert-now";
  const seg = document.createElement("div");
  seg.className = "seg alert-kinds";
  const value = Object.assign(document.createElement("input"), { inputMode: "decimal", autocomplete: "off", required: true });
  const valueLabel = label(aT().price, value);
  const repeatBox = Object.assign(document.createElement("input"), { type: "checkbox" });
  const repeat = document.createElement("label");
  repeat.className = "alert-repeat";
  repeat.append(repeatBox, Object.assign(document.createElement("span"), { textContent: aT().repeat }));
  const error = Object.assign(document.createElement("p"), { className: "form-error" });
  const save = Object.assign(document.createElement("button"), { type: "submit", className: "act pf-save", textContent: aT().save });
  const done = document.createElement("div");
  done.className = "alert-done";
  done.hidden = true;

  const percent = () => kind === "rise" || kind === "fall";
  function prefill() {
    valueLabel.querySelector("span").textContent = percent() ? aT().percent : aT().price;
    const current = picked?.price;
    if (percent()) value.value = "5";
    else if (Number.isFinite(current)) value.value = String(Number((current * (kind === "above" ? 1.05 : 0.95)).toPrecision(4)));
    else value.value = "";
    now.textContent = picked ? `${aT().now}: ${picked.name} ${Number.isFinite(current) ? price(current) : ""}${Number.isFinite(picked.change24h) ? ` · ${percentText(picked.change24h)}` : ""}` : "";
  }
  for (const name of ["above", "below", "rise", "fall"]) {
    const button = Object.assign(document.createElement("button"), { type: "button", textContent: aT()[name], className: name === kind ? "on" : "" });
    button.addEventListener("click", () => {
      kind = name;
      for (const other of seg.children) other.classList.toggle("on", other === button);
      prefill();
    });
    seg.append(button);
  }
  async function pick(next) {
    picked = next;
    coinInput.value = next ? `${next.name} (${next.symbol})` : "";
    suggest.hidden = true;
    // A coin from search has no price yet: its page data has it.
    if (next && !Number.isFinite(next.price)) {
      const data = await fetch(`/market/coin/${encodeURIComponent(next.id)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      if (data && picked === next) picked = { ...next, price: data.price, change24h: data.change24h };
    }
    prefill();
  }
  let timer = null;
  coinInput.addEventListener("input", () => {
    picked = null;
    const query = coinInput.value.trim().toLowerCase();
    const draw = (list) => {
      suggest.replaceChildren(...list.slice(0, 8).map((item) => {
        const option = document.createElement("a");
        option.href = "#";
        option.append(logo(item), Object.assign(document.createElement("b"), { textContent: item.name }),
          Object.assign(document.createElement("span"), { className: "muted", textContent: item.symbol }));
        option.addEventListener("mousedown", (event) => { event.preventDefault(); void pick(item); });
        return option;
      }));
      suggest.hidden = !list.length;
    };
    if (!query) { suggest.hidden = true; return; }
    const local = (overview()?.coins ?? []).filter((item) => item.name.toLowerCase().includes(query) || item.symbol.toLowerCase().startsWith(query));
    draw(local);
    clearTimeout(timer);
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      const found = await fetch(`/market/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      if (coinInput.value.trim().toLowerCase() !== query || !found?.coins) return;
      const seen = new Set(local.map((item) => item.id));
      draw([...local, ...found.coins.filter((item) => !seen.has(item.id))]);
    }, 300);
  });
  coinInput.addEventListener("blur", () => setTimeout(() => { suggest.hidden = true; }, 150));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!picked) { error.textContent = aT().pickCoin; return; }
    const number = Number(value.value.replace(/\s/g, "").replace(",", "."));
    if (!(number > 0)) { error.textContent = aT().badValue; return; }
    const { status, data } = await send("/market/me/alerts", "POST", { coinId: picked.id, name: picked.name, symbol: picked.symbol,
      kind, value: number, repeat: repeatBox.checked, lang: language });
    if (status !== 201) { error.textContent = data.error ?? aT().failed; return; }
    pushKey = data.push?.key ?? pushKey;
    onSaved(data);
    // Then offer notifications in this browser, unless they are on already.
    for (const node of [seg, valueLabel, repeat, error, save, now]) node.hidden = true;
    if (!coin) coinBox.parentElement.hidden = true;
    const control = document.createElement("div");
    done.replaceChildren(Object.assign(document.createElement("p"), { textContent: aT().saved }), control);
    done.hidden = false;
    if (await pushControl(control) === "on") setTimeout(() => dialog.close(), 1500);
  });

  form.append(top);
  if (!coin) form.append(label(aT().coin, coinBox));
  form.append(now, seg, valueLabel, repeat, error, save, done);
  dialog.append(form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  if (coin) void pick(coin); else { prefill(); coinInput.focus(); }
}
