// Agent Console — talks to /.netlify/functions/agent-admin with a bearer-style token.

const TOKEN_KEY = "bd_admin_token";
let token = null;

try {
  token = sessionStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

const $ = (sel) => document.querySelector(sel);
const login = $("#login");
const consoleView = $("#console");
const panel = $("[data-panel]");

async function api(path, options = {}) {
  const res = await fetch("/.netlify/functions/agent-admin" + path, {
    ...options,
    headers: { "x-admin-token": token || "", "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (res.status === 401) {
    showLogin("Token rejected.");
    throw new Error("unauthorised");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function showLogin(message) {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  token = null;
  login.hidden = false;
  consoleView.hidden = true;
  if (message) $("[data-login-status]").textContent = message;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB");
}

async function renderStatus() {
  const s = await api("?view=status");
  $("[data-status]").innerHTML =
    `<strong>Mode:</strong> ${esc(s.mode)} &nbsp; ` +
    `<strong>Kill switch:</strong> ${s.killSwitch ? "ON" : "off"} &nbsp; ` +
    `<strong>Pending:</strong> ${s.pendingTasks} &nbsp; ` +
    `<strong>Awaiting approval:</strong> ${s.awaitingApproval} &nbsp; ` +
    `<strong>Emails this hour:</strong> ${s.emailsSentThisHour} &nbsp; ` +
    `<strong>Gmail:</strong> ${s.gmailConfigured ? "ok" : "not set"} &nbsp; ` +
    `<strong>Claude:</strong> ${s.anthropicConfigured ? "ok" : "not set"}`;
}

function card(inner) {
  return `<article class="card admin-card">${inner}</article>`;
}

async function renderApprovals() {
  const { approvals } = await api("?view=approvals");
  if (!approvals.length) {
    panel.innerHTML = "<p>Nothing awaiting approval.</p>";
    return;
  }
  panel.innerHTML = approvals.map((a) => {
    const o = a.value.outcome || {};
    const e = o.proposedEmail || {};
    const viol = (o.guardrail || []).map((v) => v.message).join("; ");
    return card(
      `<p class="eyebrow">${esc(o.agent)} · ${esc(a.value.reason || "")}</p>` +
      `<p><strong>To:</strong> ${esc(e.to || "—")}<br><strong>Subject:</strong> ${esc(e.subject || "—")}</p>` +
      (viol ? `<p><strong>Guardrail:</strong> ${esc(viol)}</p>` : "") +
      `<pre class="admin-pre">${esc(e.body || o.internalNotes || "")}</pre>` +
      `<div class="actions">` +
      `<button type="button" data-approve="${esc(a.key)}">Approve &amp; send</button>` +
      `<button type="button" class="btn secondary" data-reject="${esc(a.key)}">Reject</button>` +
      `</div>`
    );
  }).join("");
}

async function renderQueue() {
  const { tasks } = await api("?view=queue");
  panel.innerHTML = tasks.length
    ? tasks.map((t) => card(
        `<p class="eyebrow">${esc(t.value.task.agent)} · attempts ${t.value.attempts || 0}</p>` +
        `<p>${esc(t.value.task.objective)}</p>` +
        `<p class="admin-muted">${esc(t.value.source)} · ${fmtWhen(t.value.enqueuedAt)}</p>`
      )).join("")
    : "<p>Queue is empty.</p>";
}

async function renderAudit() {
  const { audit } = await api("?view=audit&limit=60");
  panel.innerHTML = audit.length
    ? audit.map((r) => card(
        `<p class="eyebrow">${esc(r.type || "run")} · ${esc(r.agent || r.subject || "")} · ${fmtWhen(r.at)}</p>` +
        (r.emailStatus ? `<p><strong>Email:</strong> ${esc(r.emailStatus)}</p>` : "") +
        `<pre class="admin-pre">${esc(r.internalNotes || JSON.stringify(r.detail || {}, null, 2))}</pre>`
      )).join("")
    : "<p>No audit records yet.</p>";
}

async function renderCrm() {
  const { crm } = await api("?view=crm");
  panel.innerHTML = crm.length
    ? crm.map((c) => card(
        `<p class="eyebrow">${esc(c.email)} · ${esc(c.status || "—")}</p>` +
        `<p><strong>Next:</strong> ${esc(c.nextAction || "—")}${c.nextFollowUpAt ? " by " + fmtWhen(c.nextFollowUpAt) : ""}</p>` +
        `<pre class="admin-pre">${esc((c.history || []).map((h) => `${fmtWhen(h.at)} — ${h.by}: ${h.status || ""} ${h.note || ""}`).join("\n"))}</pre>`
      )).join("")
    : "<p>No CRM records yet.</p>";
}

const TABS = { approvals: renderApprovals, queue: renderQueue, audit: renderAudit, crm: renderCrm };
let currentTab = "approvals";

async function refresh() {
  try {
    await renderStatus();
    await TABS[currentTab]();
  } catch (err) {
    if (err.message !== "unauthorised") panel.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}

function initConsole() {
  login.hidden = true;
  consoleView.hidden = false;

  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.removeAttribute("aria-current"));
      btn.setAttribute("aria-current", "page");
      refresh();
    });
  });

  $("[data-kill]").addEventListener("click", async () => {
    const s = await api("?view=status");
    await api("", { method: "POST", body: JSON.stringify({ action: "killswitch", on: !s.killSwitch }) });
    refresh();
  });

  panel.addEventListener("click", async (event) => {
    const approve = event.target.closest("[data-approve]");
    const reject = event.target.closest("[data-reject]");
    if (!approve && !reject) return;
    event.target.disabled = true;
    try {
      if (approve) {
        await api("", { method: "POST", body: JSON.stringify({ action: "approve", key: approve.dataset.approve }) });
      } else {
        await api("", { method: "POST", body: JSON.stringify({ action: "reject", key: reject.dataset.reject }) });
      }
      refresh();
    } catch (err) {
      alert(err.message);
      event.target.disabled = false;
    }
  });

  refresh();
  window.setInterval(refresh, 20000);
}

document.addEventListener("DOMContentLoaded", () => {
  const themeToggle = document.querySelector(".theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      document.body.classList.toggle("light");
    });
  }

  $("[data-logout]").addEventListener("click", () => showLogin("Signed out."));

  $("[data-login-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    token = $("#token").value.trim();
    try {
      await api("?view=status");
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
      initConsole();
    } catch {
      showLogin("Token rejected.");
    }
  });

  if (token) {
    api("?view=status").then(initConsole).catch(() => showLogin());
  } else {
    showLogin();
  }
});
