const messages={receive:["Получить NIR","Здесь появятся адрес и QR-код после подключения зашифрованного vault."],send:["Отправить NIR","Перед подписью кошелёк покажет адрес, сумму, комиссию и процент комиссии."],mine:["Майнинг интеллекта","Выберите роль, пройдите проверку оборудования и получите назначенное задание."]};
const panel=document.querySelector("#panel");
document.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",()=>{const [title,copy]=messages[button.dataset.action];document.querySelector("#panel-title").textContent=title;document.querySelector("#panel-copy").textContent=copy;panel.showModal()}));
document.querySelector(".close").onclick=()=>panel.close();document.querySelector(".primary").onclick=()=>panel.close();
const themeButton=document.querySelector("#theme");
const setTheme=theme=>{document.documentElement.dataset.theme=theme;themeButton.textContent=theme==="light"?"☾":"☀";localStorage.setItem("nir-theme",theme)};
setTheme(localStorage.getItem("nir-theme")||"dark");themeButton.onclick=()=>setTheme(document.documentElement.dataset.theme==="light"?"dark":"light");
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js");
