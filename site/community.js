// The community block on a coin's page: the daily "rise or fall" vote and the
// comments (latest or top, one level of replies, likes, reports, deleting
// your own). Signed-out visitors read; signing in with Google lets them take
// part. Uses common.js and coin.js (the coin's `id` and `coin`).

const talk = {
  ru: { question: (name) => `Как вам ${name} сегодня?`, rise: "Рост", fall: "Падение",
    votes: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "голос" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "голоса" : "голосов"} сегодня`,
    errors: { "wait 20 seconds between comments": "Подождите 20 секунд между комментариями.",
      "50 comments a day is the limit": "Не больше 50 комментариев в день.", "a comment is 1–1000 characters": "Комментарий — от 1 до 1000 символов.",
      "too many changes, wait a minute": "Слишком часто. Подождите минуту.", "sign in first": "Сначала войдите." },
    signToVote: "Войдите, чтобы голосовать", signToWrite: "Войти через Google, чтобы писать",
    placeholder: (name) => `Что думаете о ${name}?`, send: "Отправить", reply: "Ответить", report: "Пожаловаться",
    reported: "Жалоба отправлена", remove: "Удалить", removeAsk: "Удалить комментарий?", empty: "Пока никто не написал. Будьте первым.",
    more: "Показать ещё", ago: (date) => date.toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) },
  en: { question: (name) => `How do you feel about ${name} today?`, rise: "Rise", fall: "Fall",
    votes: (n) => `${n} ${n === 1 ? "vote" : "votes"} today`, errors: {},
    signToVote: "Sign in to vote", signToWrite: "Sign in with Google to post",
    placeholder: (name) => `What do you think about ${name}?`, send: "Post", reply: "Reply", report: "Report",
    reported: "Reported", remove: "Delete", removeAsk: "Delete this comment?", empty: "No comments yet. Be the first.",
    more: "Show more", ago: (date) => date.toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) },
};
let comments = [];
let vote = null;
let sort = "latest";
let moreComments = false;
let replyTo = null;
const say = () => talk[language];
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function renderVote() {
  const box = $("#vote");
  if (!vote || !coin) return box.replaceChildren();
  const total = vote.rise + vote.fall;
  const canVote = account.user && !vote.mine;
  const nodes = [el("b", { textContent: say().question(coin.name) })];
  if (canVote) {
    for (const side of ["rise", "fall"]) {
      const button = el("button", { type: "button", className: `vote-${side}`, textContent: `${side === "rise" ? "📈" : "📉"} ${say()[side]}` });
      button.addEventListener("click", async () => {
        const { status, data } = await send(`/market/coin/${encodeURIComponent(id)}/sentiment`, "POST", { side });
        if (status === 200) { vote = data; renderVote(); }
      });
      nodes.push(button);
    }
  } else {
    const rise = total ? Math.round(vote.rise / total * 100) : 50;
    const bar = el("div", { className: "vote-bar" }, el("i", { style: `width:${rise}%` }));
    nodes.push(el("div", { className: "vote-result" },
      el("span", { className: "up", textContent: `📈 ${say().rise} ${total ? rise : 0}%` }), bar,
      el("span", { className: "down", textContent: `${total ? 100 - rise : 0}% ${say().fall} 📉` })),
    el("small", { className: "muted", textContent: say().votes(total) }));
    if (!account.user && account.signIn) nodes.push(el("a", { href: signInUrl(), className: "act ghost", textContent: say().signToVote }));
  }
  box.replaceChildren(...nodes);
}

function composer(parentId = null) {
  if (!account.user) {
    return account.signIn ? el("a", { href: signInUrl(), className: "act", textContent: say().signToWrite }) : el("span");
  }
  let side = null;
  const text = el("textarea", { maxLength: 1000, rows: parentId ? 2 : 3, placeholder: parentId ? "" : say().placeholder(coin.name) });
  const count = el("small", { className: "muted", textContent: "0/1000" });
  const error = el("span", { className: "form-error" });
  text.addEventListener("input", () => { count.textContent = `${[...text.value].length}/1000`; });
  const tags = parentId ? [] : ["rise", "fall"].map((value) => {
    const tag = el("button", { type: "button", className: `tag-${value}`, textContent: `${value === "rise" ? "📈" : "📉"} ${say()[value]}` });
    tag.addEventListener("click", () => {
      side = side === value ? null : value;
      for (const other of tag.parentNode.querySelectorAll("[class^=tag-]")) other.classList.toggle("on", other === tag && side === value);
    });
    return tag;
  });
  const submit = el("button", { type: "submit", className: "act", textContent: parentId ? say().reply : say().send });
  const form = el("form", { className: "composer" }, text, el("div", { className: "composer-row" }, ...tags, count, error, submit));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const { status, data } = await send(`/market/coin/${encodeURIComponent(id)}/comments`, "POST", { body: text.value, side, parentId });
    submit.disabled = false;
    if (status !== 201) { error.textContent = say().errors[data.error] ?? data.error ?? "Error"; return; }
    replyTo = null;
    await loadComments();
  });
  return form;
}

function commentNode(comment, isReply = false) {
  const author = el("a", { href: `/u/${comment.author.username}`, className: "who" }, avatar(comment.author, isReply ? 24 : 32),
    el("b", { textContent: comment.author.displayName }), el("span", { className: "muted", textContent: `@${comment.author.username}` }));
  const head = el("div", { className: "comment-head" }, author, el("small", { className: "muted", textContent: say().ago(new Date(comment.createdAt)) }));
  if (comment.side) head.append(el("span", { className: `badge side-${comment.side}`, textContent: `${comment.side === "rise" ? "📈" : "📉"} ${say()[comment.side]}` }));
  const like = el("button", { type: "button", className: `like${comment.liked ? " on" : ""}`, textContent: `♥ ${comment.likes}` });
  like.addEventListener("click", async () => {
    if (!account.user) { if (account.signIn) location.href = signInUrl(); return; }
    const { status, data } = await send(`/market/comments/${comment.id}/like`, comment.liked ? "DELETE" : "PUT");
    if (status === 200) { comment.liked = data.liked; comment.likes = data.likes; like.textContent = `♥ ${data.likes}`; like.classList.toggle("on", data.liked); }
  });
  const actions = el("div", { className: "comment-actions" }, like);
  if (account.user) {
    const reply = el("button", { type: "button", textContent: say().reply });
    reply.addEventListener("click", () => { replyTo = isReply ? comment.parentId : comment.id; renderComments(); });
    actions.append(reply);
  }
  if (account.user && !comment.mine) {
    const report = el("button", { type: "button", textContent: say().report });
    report.addEventListener("click", async () => {
      const { status } = await send(`/market/comments/${comment.id}/report`, "POST");
      if (status === 200) { report.textContent = say().reported; report.disabled = true; }
    });
    actions.append(report);
  }
  if (comment.canDelete) {
    const remove = el("button", { type: "button", textContent: say().remove });
    remove.addEventListener("click", async () => {
      if (!confirm(say().removeAsk)) return;
      if ((await send(`/market/comments/${comment.id}`, "DELETE")).status === 200) await loadComments();
    });
    actions.append(remove);
  }
  const node = el("div", { className: `comment${isReply ? " reply" : ""}` }, head, el("p", { textContent: comment.body }), actions);
  if (!isReply) {
    const thread = el("div", { className: "replies" }, ...(comment.replies ?? []).map((item) => commentNode(item, true)));
    if (replyTo === comment.id) thread.append(composer(comment.id));
    node.append(thread);
  }
  return node;
}

function renderComments() {
  $("#composer").replaceChildren(composer());
  $("#comments").replaceChildren(...(comments.length ? comments.map((comment) => commentNode(comment))
    : [el("p", { className: "muted", textContent: say().empty })]));
  $("#more-comments").hidden = !moreComments;
  $("#more-comments").textContent = say().more;
  for (const button of document.querySelectorAll("[data-sort]")) button.classList.toggle("on", button.dataset.sort === sort);
}

function renderCommunity() {
  // The block shows when people can sign in, or when there is already something to read.
  const visible = Boolean(coin && (account.signIn || comments.length || (vote && vote.rise + vote.fall)));
  $("#community").hidden = !visible;
  $("#tab-community").hidden = !visible;
  if (!visible) return;
  renderVote();
  renderComments();
}

async function loadComments(more = false) {
  const before = more && comments.length ? `&before=${comments.at(-1).id}` : "";
  const response = await fetch(`/market/coin/${encodeURIComponent(id)}/comments?sort=${sort}${before}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const page = (await response.json()).comments;
  comments = more ? [...comments, ...page] : page;
  moreComments = sort === "latest" && page.length === 30;
  renderCommunity();
}
async function loadVote() {
  const response = await fetch(`/market/coin/${encodeURIComponent(id)}/sentiment`, { cache: "no-store" }).catch(() => null);
  if (response?.ok) { vote = await response.json(); renderCommunity(); }
}

for (const button of document.querySelectorAll("[data-sort]")) {
  button.addEventListener("click", () => { sort = button.dataset.sort; void loadComments(); });
}
$("#more-comments").addEventListener("click", () => { void loadComments(true); });
if (COIN_ID_PATTERN.test(id)) {
  void loadComments();
  void loadVote();
}
