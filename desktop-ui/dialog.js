// One question from NIR: the id and one-time token arrive in the fragment,
// which is never sent over HTTP and is removed from the address at once.
const match = /^#([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(location.hash);
history.replaceState(null, "", location.pathname);
const id = match?.[1];
const headers = { "content-type": "application/json", "x-nir-dialog": match?.[2] ?? "" };
const post = (path, body) => fetch(path, { method: "POST", headers, body: JSON.stringify({ id, ...body }) });

function finished() {
  document.querySelector("#dialog").hidden = true;
  document.querySelector("#closed").hidden = false;
  window.close();
}

async function show() {
  if (!id) return finished();
  const response = await post("/dialog/state", {});
  if (!response.ok) return finished();
  const spec = await response.json();
  document.title = `NIR — ${spec.title}`;
  document.documentElement.lang = spec.language === "en" ? "en" : "ru";
  document.querySelector("#title").textContent = spec.title;
  document.querySelector("#message").textContent = spec.message ?? "";
  if (spec.words) {
    const list = document.querySelector("#words");
    list.hidden = false;
    spec.words.forEach((word) => {
      const item = document.createElement("li");
      item.textContent = word;
      list.append(item);
    });
  }
  const fields = document.querySelector("#fields");
  for (const field of spec.fields ?? []) {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = field.label;
    const input = document.createElement(field.type === "words" ? "textarea" : "input");
    input.name = field.name;
    input.spellcheck = false;
    input.autocapitalize = "off";
    if (field.type === "password") input.type = "password";
    if (field.type === "words") input.rows = 4;
    label.append(caption, input);
    fields.append(label);
  }
  if (spec.error) document.querySelector("#error").textContent = spec.error;
  const form = document.querySelector("#form");
  let chosen = null;
  for (const button of spec.buttons) {
    const element = document.createElement("button");
    element.type = button.primary ? "submit" : "button";
    element.textContent = button.label;
    element.className = button.primary ? "primary" : "";
    element.addEventListener("click", () => { chosen = button.id; if (!button.primary) form.requestSubmit(); });
    document.querySelector("#buttons").append(element);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const primary = spec.buttons.find((button) => button.primary)?.id;
    const values = Object.fromEntries([...form.querySelectorAll("input,textarea")].map((input) => [input.name, input.value]));
    for (const input of form.querySelectorAll("input,textarea")) input.value = "";
    await post("/dialog/answer", { button: chosen ?? primary, values }).catch(() => {});
    finished();
  });
  document.querySelector("#dialog").hidden = false;
  form.querySelector("input,textarea,button.primary")?.focus();
  setInterval(async () => {
    try {
      const alive = await post("/dialog/alive", {});
      if (!alive.ok) finished();
    } catch { finished(); }
  }, 2000);
}

show().catch(finished);
