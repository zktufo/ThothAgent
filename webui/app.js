const state = {
  ws: null,
  requestId: 0,
  pending: new Map(),
  sessions: [],
  currentSessionId: "",
  expandedSessionId: "",
  liveTrace: [],
  isThinking: false,
  historySessionId: "",
};

const el = {
  liveStatus: document.getElementById("liveStatus"),
  liveDot: document.getElementById("liveDot"),
  activeModel: document.getElementById("activeModel"),
  activeSession: document.getElementById("activeSession"),
  tokenUsage: document.getElementById("tokenUsage"),
  budgetFill: document.getElementById("budgetFill"),
  homeRoot: document.getElementById("homeRoot"),
  gatewayAddress: document.getElementById("gatewayAddress"),
  sessionList: document.getElementById("sessionList"),
  primaryModel: document.getElementById("primaryModel"),
  fallbackModels: document.getElementById("fallbackModels"),
  saveRouteButton: document.getElementById("saveRouteButton"),
  refreshButton: document.getElementById("refreshButton"),
  resetButton: document.getElementById("resetButton"),
  endButton: document.getElementById("endButton"),
  chatLog: document.getElementById("chatLog"),
  thinkingStrip: document.getElementById("thinkingStrip"),
  thinkingLabel: document.getElementById("thinkingLabel"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  chatSessionKey: document.getElementById("chatSessionKey"),
};

async function boot() {
  bindEvents();
  await connectSocket();
  await refreshAll();
}

function bindEvents() {
  el.sendButton.addEventListener("click", sendMessage);
  el.refreshButton.addEventListener("click", refreshAll);
  el.resetButton.addEventListener("click", resetSession);
  el.endButton.addEventListener("click", endSession);
  el.saveRouteButton.addEventListener("click", saveRoute);
  el.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      sendMessage();
    }
  });
  el.sessionList.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-session-trigger]");
    if (!trigger) return;
    const sessionId = trigger.getAttribute("data-session-trigger") || "";
    state.expandedSessionId = state.expandedSessionId === sessionId ? "" : sessionId;
    if (sessionId) {
      state.historySessionId = sessionId;
      await loadChatHistory(sessionId);
    }
    renderSessions();
  });
}

async function connectSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

  await new Promise((resolve) => {
    state.ws = new WebSocket(`ws://${location.host}`);

    state.ws.addEventListener("open", () => {
      setLiveState("live");
      resolve();
    }, { once: true });

    state.ws.addEventListener("close", () => {
      setLiveState("offline");
      setTimeout(() => {
        void connectSocket().then(() => refreshAll()).catch(console.error);
      }, 2500);
    });

    state.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "res") {
        const pending = state.pending.get(message.id);
        if (!pending) return;
        state.pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.payload);
        } else {
          pending.reject(new Error(message.error || "gateway rpc error"));
        }
        return;
      }

      if (message.type === "event" && message.event === "chat.stream") {
        handleAgentEvent(message.payload);
      }
    });
  });
}

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error("gateway offline"));
      return;
    }
    const id = `rpc_${Date.now()}_${state.requestId++}`;
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ id, method, params }));
  });
}

function setLiveState(label) {
  el.liveStatus.textContent = label;
  el.liveDot.classList.toggle("live", label === "live");
}

async function refreshAll() {
  await Promise.all([
    loadStatus(),
    loadModels(),
    loadSessions(),
  ]);
  await loadChatHistory(state.historySessionId || state.currentSessionId || "");
}

async function loadStatus() {
  const data = await request("status");
  el.activeModel.textContent = data.runtime.activeModel || "-";
  el.activeSession.textContent = data.runtime.sessionKey || "-";
  el.chatSessionKey.textContent = data.runtime.sessionKey || "-";
  el.tokenUsage.textContent = `${data.runtime.tokenUsage.totalTokens} / ${data.runtime.tokenUsage.maxTokens}`;
  el.budgetFill.style.width = `${Math.max(1, Math.floor(data.runtime.tokenUsage.usageFraction * 100))}%`;
  el.homeRoot.textContent = data.home.root;
  el.gatewayAddress.textContent = `http://${data.gateway.host}:${data.gateway.port}`;
}

async function loadModels() {
  const data = await request("models.list");
  const items = data.items || [];
  const current = data.current || {};

  el.primaryModel.innerHTML = items.map((item) =>
    `<option value="${escapeHtml(item.route)}"${item.route === current.primary ? " selected" : ""}>${escapeHtml(item.route)}</option>`
  ).join("");

  el.fallbackModels.innerHTML = items.map((item) =>
    `<option value="${escapeHtml(item.route)}"${(current.fallbacks || []).includes(item.route) ? " selected" : ""}>${escapeHtml(item.route)}</option>`
  ).join("");
}

async function loadSessions() {
  const data = await request("sessions.list", { limit: 20 });
  state.sessions = data.items || [];
  state.currentSessionId = data.currentSessionId || "";
  if (!state.expandedSessionId && state.currentSessionId) {
    state.expandedSessionId = state.currentSessionId;
  }
  if (!state.historySessionId && state.currentSessionId) {
    state.historySessionId = state.currentSessionId;
  }
  renderSessions();
}

async function loadChatHistory(sessionId) {
  if (!sessionId) return;
  const data = await request("chat.history", { sessionId, limit: 80 });
  renderHistory(data.messages || []);
  if (data.session?.sessionKey) {
    el.chatSessionKey.textContent = data.session.sessionKey;
  }
}

function renderHistory(messages) {
  el.chatLog.innerHTML = "";
  messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .forEach((message) => {
      const tone = message.role === "tool" ? "system" : message.role;
      appendMessage(message.role, message.contentSummary || message.content || "", tone, false);
    });
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function renderSessions() {
  const merged = state.sessions.map((session) => {
    if (session.id !== state.currentSessionId || state.liveTrace.length === 0) {
      return session;
    }
    return {
      ...session,
      actions: [...(session.actions || []), ...state.liveTrace],
    };
  });

  el.sessionList.innerHTML = merged.map((session) => {
    const expanded = session.id === state.expandedSessionId;
    const current = session.id === state.currentSessionId;
    const viewing = session.id === state.historySessionId;
    const actions = session.actions || [];
    const summary = session.summary?.markdown
      ? summarize(session.summary.markdown.replace(/^#+\s*/gm, "").trim(), 120)
      : "暂无摘要";

    return `
      <article class="session-card ${expanded ? "expanded" : ""} ${current ? "current" : ""} ${viewing ? "viewing" : ""}">
        <button class="session-trigger" type="button" data-session-trigger="${escapeHtml(session.id)}">
          <div class="session-title">
            <strong>${escapeHtml(session.title || "新会话")}</strong>
            <span class="session-status">${escapeHtml(session.status || "active")}</span>
          </div>
          <div class="session-meta">${escapeHtml(session.sessionKey)}</div>
          <div class="session-summary">${escapeHtml(summary)}</div>
          <div class="session-meta">${escapeHtml(formatDateTime(session.lastActivityAt))} · ${actions.length} trace</div>
        </button>
        <div class="session-drawer">
          <div class="session-summary">${escapeHtml(summary)}</div>
          <div class="session-trace-list">
            ${actions.length
              ? actions.slice().reverse().map(renderTraceItem).join("")
              : `<div class="trace-item"><div class="trace-meta">暂无 tool trace</div></div>`}
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderTraceItem(action) {
  const toolName = action.toolName || action.actionType || "trace";
  const status = action.outputStatus || action.actionType || "done";
  const inputText = action.inputJson ? safeParse(action.inputJson) : "";
  const detail = action.outputSummary || inputText || "无额外信息";

  return `
    <div class="trace-item">
      <div class="trace-head">
        <div class="trace-pill">${escapeHtml(toolName)}</div>
        <span class="trace-status">${escapeHtml(status)}</span>
      </div>
      <div class="trace-meta">${escapeHtml(formatDateTime(action.createdAt))}</div>
      <div class="trace-body">${escapeHtml(detail)}</div>
    </div>
  `;
}

async function saveRoute() {
  const primary = el.primaryModel.value;
  const fallbacks = [...el.fallbackModels.selectedOptions].map((option) => option.value).filter((route) => route !== primary);
  await request("models.route", { primary, fallbacks });
  await refreshAll();
}

async function resetSession() {
  await request("sessions.patch", { action: "reset" });
  appendSystemMessage("会话已重置，已切换到新的 session。");
  state.liveTrace = [];
  await refreshAll();
}

async function endSession() {
  await request("sessions.patch", { action: "end" });
  appendSystemMessage("当前会话已结束并归档，新的 session 已创建。");
  state.liveTrace = [];
  await refreshAll();
}

async function sendMessage() {
  const text = el.messageInput.value.trim();
  if (!text || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  el.messageInput.value = "";
  appendMessage("user", text);
  setThinkingState(true, "Thinking…");
  state.liveTrace = [];
  renderSessions();

  await request("chat.send", {
    message: text,
    agentId: "default",
  });
}

function handleAgentEvent(payload) {
  if (payload.stream === "tool") {
    const data = payload.data || {};
    state.liveTrace.push({
      toolName: data.toolName || data.type || "tool",
      actionType: data.type || "tool",
      outputStatus: data.success === false ? "error" : (data.type === "tool_use" ? "started" : "success"),
      outputSummary: data.message || safeParse(data.input || ""),
      inputJson: JSON.stringify(data.input || {}),
      createdAt: new Date().toISOString(),
    });
    setThinkingState(true, `Thinking · ${data.toolName || "tool"}…`);
    renderSessions();
    return;
  }

  if (payload.stream === "timing") {
    const message = (payload.data || []).map((item) => `${item.label}:${item.elapsed}ms`).join(" · ");
    state.liveTrace.push({
      toolName: "timing",
      actionType: "timing",
      outputStatus: "success",
      outputSummary: message,
      createdAt: new Date().toISOString(),
    });
    renderSessions();
    return;
  }

  if (payload.stream === "lifecycle" && payload.phase === "end") {
    void appendAssistantTyping(payload.text || "");
    setThinkingState(false, "已完成");
    state.liveTrace = [];
    state.historySessionId = payload.session?.id || state.currentSessionId;
    void refreshAll();
    return;
  }

  if (payload.stream === "lifecycle" && payload.phase === "error") {
    appendSystemMessage(payload.error || "Unknown error");
    setThinkingState(false, "error");
    state.liveTrace = [];
    void refreshAll();
  }
}

function appendMessage(role, text, tone = role, autoScroll = true) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "你" : role === "assistant" ? "PetAgent" : "System";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${tone}`;
  bubble.textContent = text;

  row.appendChild(meta);
  row.appendChild(bubble);
  el.chatLog.appendChild(row);
  if (autoScroll) {
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }
  return bubble;
}

function appendSystemMessage(text) {
  appendMessage("assistant", text, "system");
}

async function appendAssistantTyping(text) {
  const bubble = appendMessage("assistant", "", "assistant");
  bubble.classList.add("typing");
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += 1) {
    bubble.textContent += chars[index];
    if (index % 3 === 0) {
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
      await sleep(12);
    }
  }
  bubble.classList.remove("typing");
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function setThinkingState(active, label) {
  state.isThinking = active;
  el.thinkingLabel.textContent = label;
  el.thinkingStrip.style.borderColor = active ? "rgba(255, 93, 93, 0.28)" : "";
}

function summarize(text, limit) {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function safeParse(value) {
  if (!value) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const compact = JSON.stringify(parsed);
    return summarize(compact, 220);
  } catch {
    return summarize(String(value), 220);
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

boot().catch((error) => {
  console.error(error);
  setLiveState("error");
});
