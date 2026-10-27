// The phone's bottom menu for the pages that do not load common.js (the NIR page, the privacy policy and
// the terms): the same items as on the market pages, drawn here with their own styles, in the page's language.
(() => {
  const ICONS = {
    markets: '<path d="M4 19V9m6 10V5m6 14v-7m4 7H2"/>',
    watch: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    portfolio: '<path d="M12 3v9h9A9 9 0 1 1 12 3z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
    screener: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    mine: '<path d="M3.6 12.8C4.8 9.4 7.4 6.6 10.4 5.2M20.4 12.8C19.2 9.4 16.6 6.6 13.6 5.2M7 9l11 11M17 9 6 20"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  };
  const WORDS = {
    ru: { markets: "Рынки", watch: "Избранное", portfolio: "Портфель", mine: "Майнинг", screener: "Скринеры", profile: "Профиль", signIn: "Войти", menu: "Меню", back: "Назад" },
    en: { markets: "Markets", watch: "Watchlist", portfolio: "Portfolio", mine: "Mining", screener: "Screeners", profile: "Profile", signIn: "Sign in", menu: "Menu", back: "Back" },
  };
  const style = document.createElement("style");
  style.textContent = `
    .nir-tabbar { display: none; }
    @media (max-width: 700px) {
      body { padding-bottom: calc(92px + env(safe-area-inset-bottom)); }
      .nir-tabbar { position: fixed; right: 14px; bottom: calc(16px + env(safe-area-inset-bottom)); left: 14px; z-index: 50; display: grid;
        grid-auto-flow: column; grid-auto-columns: 1fr; padding: 4px; border: 1px solid color-mix(in srgb, var(--text) 12%, transparent); border-radius: 999px;
        background: color-mix(in srgb, var(--card) 60%, transparent); box-shadow: 0 8px 28px rgba(0, 0, 0, .22), inset 0 1px 0 rgba(255, 255, 255, .18);
        -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
        font-family: -apple-system, BlinkMacSystemFont, Inter, "Segoe UI", sans-serif; }
      .nir-tabbar a { display: grid; justify-items: center; gap: 1px; padding: 5px 0 4px; border-radius: 999px; color: var(--muted); font-size: 9.5px;
        font-weight: 650; text-decoration: none; }
      .nir-tabbar a[hidden] { display: none; }
      .nir-tabbar a.on { color: var(--text); background: color-mix(in srgb, var(--text) 10%, transparent); }
      .nir-tabbar svg, .nir-tabbar img { width: 22px; height: 22px; }
      .nir-tabbar svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .nir-back { display: grid; place-items: center; flex: none; width: 40px; height: 40px; margin-right: 6px; padding: 0; border: 1px solid var(--line);
        border-radius: 999px; background: none; color: var(--text); cursor: pointer; }
      .nir-back svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    }
    .nir-back { display: none; }
    @media (max-width: 700px) { .nir-back { display: grid; } }`;
  document.head.append(style);
  const bar = document.createElement("nav");
  bar.className = "nir-tabbar";
  document.body.append(bar);
  let account = { signIn: false, user: null };
  const language = () => (document.documentElement.lang === "en" ? "en" : "ru");
  function render() {
    const words = WORDS[language()];
    const signedIn = Boolean(account.user);
    const items = [
      ["/", ICONS.markets, words.markets, false],
      ["/#watch", ICONS.watch, words.watch, !signedIn],
      ["/portfolio/", ICONS.portfolio, words.portfolio, !signedIn],
      ["/nir/#start", ICONS.mine, words.mine, false, location.pathname.startsWith("/nir")],
      signedIn ? [`/u/${encodeURIComponent(account.user.username)}`, ICONS.profile, words.profile, false]
        : account.signIn ? [`/market/auth/google?return=${encodeURIComponent(location.pathname)}`, ICONS.profile, words.signIn, false]
          : ["/screener/", ICONS.screener, words.screener, false],
    ];
    bar.setAttribute("aria-label", words.menu);
    back.setAttribute("aria-label", words.back);
    bar.replaceChildren(...items.map(([href, icon, label, hidden, on]) => {
      const link = document.createElement("a");
      link.href = href;
      link.hidden = hidden;
      if (on) link.className = "on";
      link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      link.append(Object.assign(document.createElement("span"), { textContent: label }));
      return link;
    }));
  }
  // A back button in the header, as on the market pages.
  const top = document.querySelector(".top");
  const back = document.createElement("button");
  if (top) {
    back.type = "button";
    back.className = "nir-back";
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
    back.addEventListener("click", () => {
      if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
      else location.href = "/";
    });
    top.prepend(back);
  }
  render();
  // The page switches its language by setting <html lang>.
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  fetch("/market/me", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).then((answer) => {
    if (answer) { account = answer; render(); }
  }).catch(() => {});
})();
