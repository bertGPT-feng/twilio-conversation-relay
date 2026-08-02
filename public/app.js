const templates = {
  service: "你是康城通讯的AI语音助理。请先说明AI身份，再礼貌确认接听人的姓名。回答要简短、自然，每次一到两句话；不索取密码、验证码、银行卡信息，也不要求转账。",
  notice: "你是康城通讯的AI语音助理。本次电话用于业务通知，请先透明说明AI身份并确认接听人姓名，再根据当前通知内容简短说明来意。如对方否认身份，立即停止披露并礼貌结束。",
  custom: "",
};

const CONTEXT_STORAGE_PREFIX = "kangcheng-context:";
let activeContextTemplate = localStorage.getItem("kangcheng-context-template") || "service";
if (!(activeContextTemplate in templates)) activeContextTemplate = "service";

function contextStorageKey(template) {
  return `${CONTEXT_STORAGE_PREFIX}${template}`;
}

function savedContextFor(template) {
  const saved = localStorage.getItem(contextStorageKey(template));
  return saved === null ? templates[template] : saved;
}

const statusLabels = {
  pending: "等待拨打",
  dialing: "正在提交",
  queued: "已进入线路",
  ringing: "正在响铃",
  "in-progress": "通话中",
  completed: "已完成",
  busy: "占线",
  failed: "失败",
  "no-answer": "无人接听",
  canceled: "已取消",
};

let contacts = [];
let activeJob = null;
let pollTimer = null;
let dashboardUsername = sessionStorage.getItem("kangcheng-username") || "";
let dashboardPassword = sessionStorage.getItem("kangcheng-password") || "";

const rows = document.querySelector("#contactRows");
const emptyState = document.querySelector("#emptyState");
const contextInput = document.querySelector("#contextInput");
const contextCount = document.querySelector("#contextCount");
const savedState = document.querySelector("#savedState");
const contactDialog = document.querySelector("#contactDialog");
const reviewDialog = document.querySelector("#reviewDialog");
const loginDialog = document.querySelector("#loginDialog");
const toast = document.querySelector("#toast");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const reviewButton = document.querySelector("#reviewButton");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizePhone(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

function isValidPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(normalizePhone(phone));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const credentials = dashboardUsername && dashboardPassword
    ? btoa(unescape(encodeURIComponent(`${dashboardUsername}:${dashboardPassword}`)))
    : "";
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(credentials ? { Authorization: `Basic ${credentials}` } : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.message || `请求失败：${response.status}`);
    error.status = response.status;
    error.code = payload.error;
    throw error;
  }
  return payload;
}

function render() {
  rows.innerHTML = contacts.map((contact, index) => {
    const status = contact.status || "pending";
    const detail = contact.duration !== null && contact.duration !== undefined
      ? `${statusLabels[status] || status} · ${contact.duration}秒`
      : statusLabels[status] || status;
    const editingDisabled = activeJob ? "disabled" : "";
    return `
      <tr data-id="${contact.id}">
        <td class="order-cell">${String(index + 1).padStart(2, "0")}</td>
        <td><div class="contact-name"><span class="avatar">${escapeHtml(contact.name.slice(0, 1) || "?")}</span>${escapeHtml(contact.name)}</div></td>
        <td class="phone">${escapeHtml(contact.phone)}</td>
        <td><input class="note-input" value="${escapeHtml(contact.note || "")}" placeholder="点击添加备注" aria-label="${escapeHtml(contact.name)}的备注" ${editingDisabled} /></td>
        <td><span class="status ${escapeHtml(status)}">${escapeHtml(detail)}</span></td>
        <td><button class="row-menu" type="button" aria-label="删除${escapeHtml(contact.name)}" title="删除联系人" ${editingDisabled}>×</button></td>
      </tr>
    `;
  }).join("");

  emptyState.hidden = contacts.length > 0;
  document.querySelector("table").hidden = contacts.length === 0;
  document.querySelector("#contactCount").textContent = contacts.length;
  document.querySelector("#pendingCount").textContent = contacts.filter((item) =>
    ["pending", "dialing", "queued", "ringing"].includes(item.status || "pending")
  ).length;
  document.querySelector("#callingCount").textContent = contacts.filter((item) =>
    item.status === "in-progress"
  ).length;
  document.querySelector("#completedCount").textContent = contacts.filter((item) =>
    item.status === "completed"
  ).length;
  document.querySelector("#failedCount").textContent = contacts.filter((item) =>
    ["failed", "busy", "no-answer", "canceled"].includes(item.status)
  ).length;

  const running = activeJob && ["running", "paused"].includes(activeJob.status);
  reviewButton.hidden = Boolean(running);
  document.querySelector("#addContactButton").disabled = Boolean(running);
  document.querySelector("#fileInput").disabled = Boolean(running);
  pauseButton.hidden = !running;
  stopButton.hidden = !running;
  pauseButton.textContent = activeJob?.status === "paused" ? "继续队列" : "暂停队列";
  reviewButton.disabled = contacts.length === 0;
}

function rowsToContacts(parsedRows) {
  return parsedRows
    .map((parts) => parts.map((part) => String(part ?? "").trim().replace(/^"|"$/g, "")))
    .filter((parts) => parts.some(Boolean))
    .map((parts) => {
      const phoneIndex = parts.findIndex((part) => /\+?\d[\d\s()-]{6,}/.test(part));
      if (phoneIndex < 0) return null;
      const phone = normalizePhone(parts[phoneIndex]);
      const name = parts.find((part, index) =>
        index !== phoneIndex &&
        part &&
        !/^(姓名|名字|联系人|电话|电话号码|手机号|phone|name)$/i.test(part)
      );
      if (!name || !isValidPhone(phone)) return null;
      return {
        id: crypto.randomUUID(),
        name: name.slice(0, 80),
        phone,
        note: "",
        status: "pending",
      };
    })
    .filter(Boolean);
}

function parseDelimitedContacts(text) {
  return rowsToContacts(
    text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(/\t|,|，|;/)),
  );
}

function parseExcelContacts(buffer) {
  if (!globalThis.fflate) throw new Error("Excel 解析组件没有加载。");
  const files = globalThis.fflate.unzipSync(new Uint8Array(buffer));
  const decode = (path) => {
    const bytes = files[path];
    return bytes ? globalThis.fflate.strFromU8(bytes) : "";
  };
  const sharedXml = decode("xl/sharedStrings.xml");
  const shared = sharedXml
    ? [...new DOMParser().parseFromString(sharedXml, "application/xml").querySelectorAll("si")]
        .map((node) => [...node.querySelectorAll("t")].map((item) => item.textContent || "").join(""))
    : [];
  const sheetPath = Object.keys(files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort()[0];
  if (!sheetPath) throw new Error("Excel 文件中没有找到工作表。");
  const sheet = new DOMParser().parseFromString(decode(sheetPath), "application/xml");
  const parsedRows = [...sheet.querySelectorAll("row")].map((row) =>
    [...row.querySelectorAll("c")].map((cell) => {
      const type = cell.getAttribute("t");
      if (type === "s") return shared[Number(cell.querySelector("v")?.textContent || 0)] || "";
      if (type === "inlineStr") {
        return [...cell.querySelectorAll("t")].map((item) => item.textContent || "").join("");
      }
      return cell.querySelector("v")?.textContent || "";
    })
  );
  return rowsToContacts(parsedRows);
}

async function importFile(file) {
  if (!file || activeJob) return;
  const extension = file.name.split(".").pop().toLowerCase();
  if (!["csv", "txt", "xlsx"].includes(extension)) {
    showToast("请选择 Excel、CSV 或 TXT 文件。");
    return;
  }
  try {
    const imported = extension === "xlsx"
      ? parseExcelContacts(await file.arrayBuffer())
      : parseDelimitedContacts(await file.text());
    if (!imported.length) {
      showToast("没有识别到联系人，请检查是否包含姓名和国际电话号码两列。");
      return;
    }
    contacts = imported;
    render();
    showToast(`已导入 ${imported.length} 位联系人。`);
  } catch (error) {
    showToast(error.message || "文件解析失败。");
  }
}

async function refreshJob() {
  if (!activeJob) return;
  try {
    const job = await api(`/api/queues/${activeJob.id}`);
    activeJob = job;
    contacts = job.contacts;
    render();
    if (["completed", "stopped", "failed"].includes(job.status)) {
      clearInterval(pollTimer);
      pollTimer = null;
      showToast(
        job.status === "completed"
          ? "本轮拨号队列已完成。"
          : job.status === "stopped"
            ? "拨号队列已停止。"
            : "拨号队列因配置错误停止。",
      );
      activeJob = null;
      render();
    }
  } catch (error) {
    if (error.status === 401) showLogin();
    else showToast(error.message);
  }
}

function beginPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshJob, 2000);
}

function updateConfirmationButton() {
  document.querySelector("#confirmDialButton").disabled =
    !document.querySelector("#confirmCheck").checked ||
    !document.querySelector("#consentCheck").checked;
}

function showLogin(message = "") {
  document.querySelector("#loginError").textContent = message;
  if (!loginDialog.open) loginDialog.showModal();
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#usernameField").value.trim();
  const password = document.querySelector("#passwordField").value;
  try {
    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "验证失败。");
      return payload;
    });
    dashboardUsername = username;
    dashboardPassword = password;
    sessionStorage.setItem("kangcheng-username", username);
    sessionStorage.setItem("kangcheng-password", password);
    loginDialog.close();
    showToast("管理身份验证成功。");
  } catch (error) {
    document.querySelector("#loginError").textContent = error.message;
  }
});

document.querySelector("#fileInput").addEventListener("change", (event) => importFile(event.target.files[0]));
const dropZone = document.querySelector("#dropZone");
["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  if (!activeJob) dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
}));
dropZone.addEventListener("drop", (event) => importFile(event.dataTransfer.files[0]));

document.querySelector("#clearButton").addEventListener("click", () => {
  if (activeJob) return showToast("请先停止当前拨号队列。");
  contacts = [];
  render();
  showToast("联系人队列已清空。");
});

document.querySelector("#addContactButton").addEventListener("click", () => contactDialog.showModal());
document.querySelector("#saveContactButton").addEventListener("click", (event) => {
  event.preventDefault();
  const name = document.querySelector("#nameField").value.trim();
  const phone = normalizePhone(document.querySelector("#phoneField").value);
  const note = document.querySelector("#noteField").value.trim();
  if (!name || !isValidPhone(phone)) {
    showToast("请填写姓名和有效的国际电话号码，例如 +85589503303。");
    return;
  }
  contacts.push({ id: crypto.randomUUID(), name, phone, note, status: "pending" });
  render();
  document.querySelector("#contactForm").reset();
  contactDialog.close();
  showToast(`${name}已加入队列。`);
});

rows.addEventListener("input", (event) => {
  if (!event.target.classList.contains("note-input")) return;
  const contact = contacts.find((item) => item.id === event.target.closest("tr").dataset.id);
  if (contact) contact.note = event.target.value;
});
rows.addEventListener("click", (event) => {
  if (!event.target.classList.contains("row-menu") || activeJob) return;
  const id = event.target.closest("tr").dataset.id;
  const contact = contacts.find((item) => item.id === id);
  contacts = contacts.filter((item) => item.id !== id);
  render();
  showToast(`${contact?.name || "联系人"}已从队列移除。`);
});

function updateContextCount() {
  contextCount.textContent = `${contextInput.value.length} / 2000`;
}
contextInput.addEventListener("input", () => {
  updateContextCount();
  localStorage.setItem(contextStorageKey(activeContextTemplate), contextInput.value);
  savedState.textContent = "已自动保存";
});
document.querySelectorAll(".chip").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".chip").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  activeContextTemplate = button.dataset.template;
  localStorage.setItem("kangcheng-context-template", activeContextTemplate);
  contextInput.value = savedContextFor(activeContextTemplate);
  updateContextCount();
  savedState.textContent = "已自动保存";
  if (activeContextTemplate === "custom") contextInput.select();
}));

reviewButton.addEventListener("click", () => {
  const invalid = contacts.find((contact) => !contact.name || !isValidPhone(contact.phone));
  if (invalid) return showToast(`请检查${invalid.name || "联系人"}的电话号码。`);
  const numbers = contacts.map((contact) => `${contact.name} ${contact.phone}`).join("；");
  document.querySelector("#reviewCopy").textContent =
    `即将真实拨打 ${contacts.length} 位联系人：${numbers}。每通结束后按设定间隔继续。`;
  document.querySelector("#reviewContext").textContent = contextInput.value || "尚未填写上下文";
  document.querySelector("#confirmCheck").checked = false;
  document.querySelector("#consentCheck").checked = false;
  updateConfirmationButton();
  reviewDialog.showModal();
});
document.querySelector("#confirmCheck").addEventListener("change", updateConfirmationButton);
document.querySelector("#consentCheck").addEventListener("change", updateConfirmationButton);
document.querySelector("#confirmDialButton").addEventListener("click", async () => {
  const button = document.querySelector("#confirmDialButton");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const job = await api("/api/queues", {
      method: "POST",
      body: JSON.stringify({
        contacts: contacts.map(({ name, phone, note }) => ({ name, phone, note })),
        context: contextInput.value,
        intervalSeconds: Number(document.querySelector("#intervalInput").value),
      }),
    });
    activeJob = job;
    contacts = job.contacts;
    reviewDialog.close();
    render();
    beginPolling();
    showToast("真实拨号队列已启动。");
  } catch (error) {
    if (error.status === 401 || error.code === "DASHBOARD_PASSWORD_NOT_CONFIGURED") {
      reviewDialog.close();
      showLogin(error.message);
    } else {
      showToast(error.message);
    }
  } finally {
    button.textContent = "确认并开始拨号";
    updateConfirmationButton();
  }
});

pauseButton.addEventListener("click", async () => {
  if (!activeJob) return;
  const action = activeJob.status === "paused" ? "resume" : "pause";
  try {
    activeJob = await api(`/api/queues/${activeJob.id}/${action}`, { method: "POST" });
    render();
    showToast(action === "pause" ? "队列已暂停；当前通话不会被中断。" : "队列已继续。");
  } catch (error) {
    showToast(error.message);
  }
});

stopButton.addEventListener("click", async () => {
  if (!activeJob) return;
  if (!confirm("停止队列会结束当前通话，并取消所有尚未拨打的联系人。确定停止吗？")) return;
  try {
    activeJob = await api(`/api/queues/${activeJob.id}/stop`, { method: "POST" });
    contacts = activeJob.contacts;
    clearInterval(pollTimer);
    pollTimer = null;
    activeJob = null;
    render();
    showToast("拨号队列已停止。");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#settingsButton").addEventListener("click", () =>
  showToast("账号密钥由 Railway 环境变量安全管理。")
);

const legacySavedContext = localStorage.getItem("kangcheng-context");
if (
  activeContextTemplate === "service" &&
  localStorage.getItem(contextStorageKey("service")) === null &&
  legacySavedContext !== null
) {
  localStorage.setItem(contextStorageKey("service"), legacySavedContext);
}
document.querySelectorAll(".chip").forEach((button) =>
  button.classList.toggle("active", button.dataset.template === activeContextTemplate)
);
contextInput.value = savedContextFor(activeContextTemplate);
updateContextCount();
render();

api("/api/session").catch((error) => {
  if (error.status === 401 || error.code === "DASHBOARD_PASSWORD_NOT_CONFIGURED") {
    showLogin(error.message);
  } else {
    showToast(error.message);
  }
});
