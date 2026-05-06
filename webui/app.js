const state = {
  ws: null,
  requestId: 0,
  pending: new Map(),
  sessions: [],
  historyMessages: [],
  currentSessionId: "",
  currentSessionKey: "",
  sessionIndex: null,
  liveTrace: [],
  isThinking: false,
  historySessionId: "",
  followCurrentSession: true,
  currentPage: "chat",
  currentSettingsTab: "general",
  dashboardSeries: [42, 48, 40, 58, 50, 64, 61, 72, 68, 74, 66, 79],
  runtimeStatus: {
    activeModel: "-",
    sessionKey: "-",
    sessionIndexKey: "-",
  },
  ui: {
    autoFocus: true,
    traceExpanded: false,
    fastSync: true,
    motionLevel: 72,
    streamLevel: 58,
  },
  attachments: [],
  mediaRecorder: null,
  recordingStream: null,
  recognition: null,
  voiceMode: "idle",
  unreadWhileDetached: false,
  renderStaggerIndex: 0,
};

const el = {
  mainCanvas: document.querySelector(".main-canvas"),
  liveStatus: document.getElementById("liveStatus"),
  liveDot: document.getElementById("liveDot"),
  tokenUsage: document.getElementById("tokenUsage"),
  budgetFill: document.getElementById("budgetFill"),
  homeRoot: document.getElementById("homeRoot"),
  gatewayAddress: document.getElementById("gatewayAddress"),
  primaryModel: document.getElementById("primaryModel"),
  sessionSelector: document.getElementById("sessionSelector"),
  refreshButton: document.getElementById("refreshButton"),
  chatLog: document.getElementById("chatLog"),
  newMessagesButton: document.getElementById("newMessagesButton"),
  thinkingStrip: document.getElementById("thinkingStrip"),
  thinkingLabel: document.getElementById("thinkingLabel"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  voiceButton: document.getElementById("voiceButton"),
  imageButton: document.getElementById("imageButton"),
  fileButton: document.getElementById("fileButton"),
  imageInput: document.getElementById("imageInput"),
  fileInput: document.getElementById("fileInput"),
  attachmentStrip: document.getElementById("attachmentStrip"),
  chatSessionKey: document.getElementById("chatSessionKey"),
  indexedSessionKey: document.getElementById("indexedSessionKey"),
  pageTitle: document.getElementById("pageTitle"),
  pageEyebrow: document.getElementById("pageEyebrow"),
  pages: {
    chat: document.getElementById("pageChat"),
    dashboard: document.getElementById("pageDashboard"),
    settings: document.getElementById("pageSettings"),
  },
  navItems: Array.from(document.querySelectorAll(".sidebar-item")),
  settingsTabs: Array.from(document.querySelectorAll(".settings-tab")),
  settingsPanels: {
    general: document.getElementById("settings-general"),
    advanced: document.getElementById("settings-advanced"),
    network: document.getElementById("settings-network"),
  },
  wavePath: document.getElementById("wavePath"),
  waveGlow: document.getElementById("waveGlow"),
  statCpu: document.getElementById("statCpu"),
  statTraffic: document.getElementById("statTraffic"),
  statTasks: document.getElementById("statTasks"),
  dashGateway: document.getElementById("dashGateway"),
  dashModel: document.getElementById("dashModel"),
  dashSession: document.getElementById("dashSession"),
  dashIndex: document.getElementById("dashIndex"),
  settingsGatewayAddress: document.getElementById("settingsGatewayAddress"),
  switchAutoFocus: document.getElementById("switchAutoFocus"),
  switchTraceExpanded: document.getElementById("switchTraceExpanded"),
  switchFastSync: document.getElementById("switchFastSync"),
  motionSlider: document.getElementById("motionSlider"),
  motionSliderValue: document.getElementById("motionSliderValue"),
  streamSlider: document.getElementById("streamSlider"),
  streamSliderValue: document.getElementById("streamSliderValue"),
};

const PAGE_META = {
  chat: { title: "", eyebrow: "" },
  dashboard: { title: "概览", eyebrow: "System Dashboard" },
  settings: { title: "设置", eyebrow: "Control Settings" },
};

async function boot() {
  bindEvents();
  initializeMotionLayers();
  syncUiControls();
  setPage("chat");
  setSettingsTab("general");
  drawWaveChart();
  startDashboardTicker();
  await connectSocket();
  await refreshAll();
  focusComposer();
}

function bindEvents() {
  el.sendButton.addEventListener("click", sendMessage);
  el.refreshButton.addEventListener("click", refreshAll);
  el.primaryModel.addEventListener("change", () => {
    void saveRoute();
  });
  el.voiceButton.addEventListener("click", () => {
    void toggleVoiceCapture();
  });
  el.imageButton.addEventListener("click", () => {
    el.imageInput.click();
  });
  el.fileButton.addEventListener("click", () => {
    el.fileInput.click();
  });
  el.imageInput.addEventListener("change", (event) => {
    ingestFiles(event.target.files, "image");
    event.target.value = "";
  });
  el.fileInput.addEventListener("change", (event) => {
    ingestFiles(event.target.files, "file");
    event.target.value = "";
  });

  el.sessionSelector.addEventListener("change", async (event) => {
    const sessionId = event.target.value || "";
    if (!sessionId) return;
    state.historySessionId = sessionId;
    state.followCurrentSession = sessionId === state.currentSessionId;
    await loadChatHistory(sessionId);
    renderSessions();
  });

  el.newMessagesButton.addEventListener("click", () => {
    scrollChatToBottom();
    state.unreadWhileDetached = false;
    syncNewMessagesButton();
  });

  el.chatLog.addEventListener("scroll", () => {
    if (isChatNearBottom()) {
      state.unreadWhileDetached = false;
    }
    syncNewMessagesButton();
  });

  el.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  el.navItems.forEach((button) => {
    button.addEventListener("click", () => {
      setPage(button.dataset.page || "chat");
    });
  });

  el.settingsTabs.forEach((button) => {
    button.addEventListener("click", () => {
      setSettingsTab(button.dataset.settingsTab || "general");
    });
  });

  bindSwitch(el.switchAutoFocus, (active) => {
    state.ui.autoFocus = active;
    if (active) focusComposer();
  });
  bindSwitch(el.switchTraceExpanded, (active) => {
    state.ui.traceExpanded = active;
    renderConversation();
  });
  bindSwitch(el.switchFastSync, (active) => {
    state.ui.fastSync = active;
  });

  bindSlider(el.motionSlider, el.motionSliderValue, (value) => {
    state.ui.motionLevel = value;
    document.documentElement.style.setProperty("--shadow-soft", `0 8px ${24 + Math.floor(value / 4)}px rgba(0, 0, 0, 0.04)`);
  });
  bindSlider(el.streamSlider, el.streamSliderValue, (value) => {
    state.ui.streamLevel = value;
  });
}

function initializeMotionLayers() {
  applyTopbarStagger();
  bindMainCanvasGlow();
}

function applyTopbarStagger() {
  const pills = Array.from(document.querySelectorAll(".topbar-meta > *"));
  pills.forEach((node, index) => {
    node.style.setProperty("--stagger-index", String(index));
  });
}

function bindMainCanvasGlow() {
  if (!el.mainCanvas) return;
  el.mainCanvas.addEventListener("pointermove", (event) => {
    const rect = el.mainCanvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
    const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
    document.documentElement.style.setProperty("--glow-x", `${clamp(x, 0, 100)}%`);
    document.documentElement.style.setProperty("--glow-y", `${clamp(y, 0, 100)}%`);
  });
  el.mainCanvas.addEventListener("pointerleave", () => {
    document.documentElement.style.setProperty("--glow-x", "50%");
    document.documentElement.style.setProperty("--glow-y", "24%");
  });
}

function bindSwitch(element, onChange) {
  if (!element) return;
  element.addEventListener("click", () => {
    const active = !element.classList.contains("active");
    element.classList.toggle("active", active);
    element.setAttribute("aria-pressed", String(active));
    onChange(active);
  });
}

function bindSlider(input, output, onChange) {
  if (!input || !output) return;
  const apply = () => {
    const value = Number(input.value || 0);
    output.textContent = `${value}%`;
    onChange(value);
  };
  input.addEventListener("input", apply);
  apply();
}

function syncUiControls() {
  syncSwitchState(el.switchAutoFocus, state.ui.autoFocus);
  syncSwitchState(el.switchTraceExpanded, state.ui.traceExpanded);
  syncSwitchState(el.switchFastSync, state.ui.fastSync);
  if (el.motionSlider) el.motionSlider.value = String(state.ui.motionLevel);
  if (el.streamSlider) el.streamSlider.value = String(state.ui.streamLevel);
  if (el.motionSliderValue) el.motionSliderValue.textContent = `${state.ui.motionLevel}%`;
  if (el.streamSliderValue) el.streamSliderValue.textContent = `${state.ui.streamLevel}%`;
}

function syncSwitchState(element, active) {
  if (!element) return;
  element.classList.toggle("active", active);
  element.setAttribute("aria-pressed", String(active));
}

function setPage(page) {
  state.currentPage = page;
  el.navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.page === page);
  });
  Object.entries(el.pages).forEach(([key, section]) => {
    section.classList.toggle("active", key === page);
  });
  const meta = PAGE_META[page] || PAGE_META.chat;
  el.pageTitle.textContent = meta.title;
  el.pageEyebrow.textContent = meta.eyebrow;
  document.body.classList.toggle("chat-page-active", page === "chat");
  if (page === "chat") focusComposer();
}

function setSettingsTab(tab) {
  state.currentSettingsTab = tab;
  el.settingsTabs.forEach((item) => {
    item.classList.toggle("active", item.dataset.settingsTab === tab);
  });
  Object.entries(el.settingsPanels).forEach(([key, panel]) => {
    panel.classList.toggle("active", key === tab);
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
        return;
      }

      if (message.type === "event" && message.event === "session.updated") {
        if (state.ui.fastSync) {
          void refreshAll();
        }
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
  renderSessions();
  renderDashboard();
}

async function loadStatus() {
  const data = await request("status");
  state.currentSessionId = data.runtime.sessionId || state.currentSessionId || "";
  state.currentSessionKey = data.runtime.sessionKey || "";
  state.sessionIndex = data.runtime.sessionIndex || null;
  state.runtimeStatus.activeModel = data.runtime.activeModel || "-";
  state.runtimeStatus.sessionKey = data.runtime.sessionKey || "-";
  state.runtimeStatus.sessionIndexKey = data.runtime.sessionIndex?.sessionKey || "-";

  el.chatSessionKey.textContent = `session: ${data.runtime.sessionKey || "-"}`;
  el.indexedSessionKey.textContent = `index: ${data.runtime.sessionIndex?.sessionKey || "-"}`;
  el.tokenUsage.textContent = `${data.runtime.tokenUsage.totalTokens} / ${data.runtime.tokenUsage.maxTokens}`;
  el.budgetFill.style.width = `${Math.max(1, Math.floor(data.runtime.tokenUsage.usageFraction * 100))}%`;
  el.homeRoot.textContent = data.home.root;
  const gatewayAddress = `http://${data.gateway.host}:${data.gateway.port}`;
  el.gatewayAddress.textContent = gatewayAddress;
  el.settingsGatewayAddress.textContent = gatewayAddress;

  const usageFraction = Number(data.runtime.tokenUsage.usageFraction || 0);
  updateDashboardSeries(usageFraction);
  renderDashboard();
}

async function loadModels() {
  const data = await request("models.list");
  const items = data.items || [];
  const current = data.current || {};
  el.primaryModel.innerHTML = items.map((item) =>
    `<option value="${escapeHtml(item.route)}"${item.route === current.primary ? " selected" : ""}>${escapeHtml(item.route)}</option>`
  ).join("");
}

async function loadSessions() {
  const data = await request("sessions.list", { limit: 20 });
  state.sessions = data.items || [];
  state.currentSessionId = data.currentSessionId || state.sessionIndex?.sessionId || "";
  state.sessionIndex = data.sessionIndex || state.sessionIndex;

  const selectedExists = state.sessions.some((session) => session.id === state.historySessionId);
  if ((!state.historySessionId || !selectedExists || state.followCurrentSession) && state.currentSessionId) {
    state.historySessionId = state.currentSessionId;
    state.followCurrentSession = true;
  }

  const visibleSessions = compactSessionOptions(state.sessions, state.currentSessionId, state.historySessionId);
  el.sessionSelector.innerHTML = visibleSessions.map((session) => {
    const title = session.title || "新会话";
    const prefix = session.id === state.currentSessionId ? "● " : "";
    return `<option value="${escapeHtml(session.id)}"${session.id === state.historySessionId ? " selected" : ""}>${escapeHtml(prefix + title)}</option>`;
  }).join("");
}

async function loadChatHistory(sessionId) {
  const targetSessionId = sessionId || state.sessionIndex?.sessionId || state.currentSessionId || "";
  if (!targetSessionId) return;
  const data = await request("chat.history", { sessionId: targetSessionId, limit: 80 });
  state.historyMessages = data.messages || [];
  state.sessionIndex = data.sessionIndex || state.sessionIndex;
  if (data.session?.id) {
    state.historySessionId = data.session.id;
  }
  if (data.session?.sessionKey) {
    el.chatSessionKey.textContent = `session: ${data.session.sessionKey}`;
  }
  el.indexedSessionKey.textContent = `index: ${state.sessionIndex?.sessionKey || "-"}`;
}

function renderSessions() {
  renderConversation({ stickToBottom: false, preserveViewport: true });
}

function renderConversation(options = {}) {
  const { stickToBottom = false, preserveViewport = false } = options;
  const nearBottomBeforeRender = isChatNearBottom();
  const previousBottomOffset = Math.max(0, el.chatLog.scrollHeight - el.chatLog.scrollTop);
  el.chatLog.innerHTML = "";
  state.renderStaggerIndex = 0;
  const session = state.sessions.find((item) => item.id === (state.historySessionId || state.currentSessionId));
  const persistedActions = session?.actions || [];
  const liveActions = session?.id === state.currentSessionId ? state.liveTrace : [];

  const items = [
    ...state.historyMessages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        kind: "message",
        createdAt: message.createdAt || message.created_at || "",
        payload: message,
      })),
    ...[...persistedActions, ...liveActions].map((action) => ({
      kind: "trace",
      createdAt: action.createdAt || "",
      payload: action,
    })),
  ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  items.forEach((item) => {
    if (item.kind === "message") {
      const message = item.payload;
      appendMessage(message.role, message.content || message.contentSummary || "", message.role, false);
      return;
    }
    appendTraceItem(item.payload);
  });

  if (stickToBottom || nearBottomBeforeRender) {
    scrollChatToBottom(false);
    state.unreadWhileDetached = false;
  } else if (preserveViewport) {
    el.chatLog.scrollTop = Math.max(0, el.chatLog.scrollHeight - previousBottomOffset);
  }
  syncNewMessagesButton();
}

function appendMessage(role, text, tone = role, autoScroll = true) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  row.style.setProperty("--stagger-index", String(state.renderStaggerIndex++));

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "你" : role === "assistant" ? "ThothAgent" : "System";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${tone}`;
  if (tone === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  row.appendChild(meta);
  row.appendChild(bubble);
  el.chatLog.appendChild(row);
  if (autoScroll) {
    scrollChatToBottom(false);
  }
  return bubble;
}

function appendSystemMessage(text) {
  appendMessage("system", text, "system");
}

function renderTraceItem(action) {
  const toolName = action.toolName || action.actionType || "trace";
  const status = action.outputStatus || action.actionType || "done";
  const inputText = action.inputJson ? prettyValue(action.inputJson) : "";
  const detail = action.outputSummary || safeParse(action.inputJson || "") || "无额外信息";
  const headLabel = status === "started" ? "Tool call" : "Tool output";
  const bodyTitle = action.resourceType || toolName;
  const open = state.ui.traceExpanded ? " open" : "";

  return `
    <details class="trace-card glass-subpanel"${open}>
      <summary>
        <span class="trace-origin">ThothAgent</span>
        <span class="trace-caret">▶</span>
        <span class="trace-pill">${escapeHtml(headLabel)}</span>
        <span class="trace-label">${escapeHtml(toolName)}</span>
        <span class="trace-summary">${escapeHtml(summarize(detail, 120))}</span>
        <span class="trace-status">${escapeHtml(status)}</span>
      </summary>
      <div class="trace-panel">
        <div class="trace-panel-inner">
          <div class="trace-panel-head">
            <strong>${escapeHtml(bodyTitle)}</strong>
            <span>${escapeHtml(formatDateTime(action.createdAt))}</span>
          </div>
          ${inputText ? `<div class="trace-section-title">Tool Input</div><div class="trace-code">${escapeHtml(inputText)}</div>` : ""}
          <div class="trace-section-title">Output Summary</div>
          <div class="trace-detail">${escapeHtml(detail)}</div>
        </div>
      </div>
    </details>
  `;
}

function appendTraceItem(action) {
  const wrapper = document.createElement("div");
  wrapper.className = "trace-row";
  wrapper.style.setProperty("--stagger-index", String(state.renderStaggerIndex++));
  wrapper.innerHTML = renderTraceItem(action);
  el.chatLog.appendChild(wrapper);
}

async function saveRoute() {
  const primary = el.primaryModel.value;
  await request("models.route", { primary, fallbacks: [] });
  await refreshAll();
}

async function sendMessage() {
  const text = el.messageInput.value.trim();
  const attachmentSummary = buildAttachmentSummary();
  const finalText = [text, attachmentSummary].filter(Boolean).join("\n\n");
  if (!finalText || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  el.messageInput.value = "";
  state.historyMessages.push({
    role: "user",
    content: finalText,
    contentSummary: finalText,
    createdAt: new Date().toISOString(),
  });
  renderConversation({ stickToBottom: true });
  setThinkingState(true, "Thinking…");
  state.liveTrace = [];
  clearAttachments();
  renderSessions();

  await request("chat.send", {
    message: finalText,
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
    renderDashboard();
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
    renderDashboard();
    return;
  }

  if (payload.stream === "lifecycle" && payload.phase === "end") {
    if (!isChatNearBottom()) {
      state.unreadWhileDetached = true;
    }
    state.historyMessages.push({
      role: "assistant",
      content: payload.text || "",
      contentSummary: payload.text || "",
      createdAt: new Date().toISOString(),
    });
    renderConversation({ stickToBottom: false, preserveViewport: true });
    setThinkingState(false, "已完成");
    state.liveTrace = [];
    state.historySessionId = payload.session?.id || state.currentSessionId;
    state.followCurrentSession = true;
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

function setThinkingState(active, label) {
  state.isThinking = active;
  el.thinkingLabel.textContent = label;
  el.thinkingStrip.style.borderColor = active ? "rgba(22, 119, 255, 0.32)" : "";
}

function renderDashboard() {
  const usageText = el.tokenUsage.textContent || "0 / 0";
  const totalTokens = Number((usageText.split("/")[0] || "0").trim());
  const currentTasks = state.liveTrace.length || (state.isThinking ? 1 : 0);
  const traffic = Math.max(1, state.historyMessages.length + state.sessions.length + currentTasks);
  const cpu = Math.min(96, 16 + currentTasks * 15 + Math.floor(totalTokens / 1200));

  el.statCpu.textContent = `${cpu}%`;
  el.statTraffic.textContent = `${traffic} req/min`;
  el.statTasks.textContent = String(currentTasks);
  el.dashGateway.textContent = el.gatewayAddress.textContent || "-";
  el.dashModel.textContent = state.runtimeStatus.activeModel || "-";
  el.dashSession.textContent = state.runtimeStatus.sessionKey || "-";
  el.dashIndex.textContent = state.runtimeStatus.sessionIndexKey || "-";

  drawWaveChart();
}

function startDashboardTicker() {
  setInterval(() => {
    const drift = clamp(Math.round((Math.random() - 0.45) * 16), -14, 14);
    const next = clamp((state.dashboardSeries.at(-1) || 56) + drift, 18, 92);
    state.dashboardSeries = [...state.dashboardSeries.slice(-23), next];
    drawWaveChart();
  }, 1800);
}

function updateDashboardSeries(usageFraction) {
  const value = clamp(Math.round(usageFraction * 100), 10, 96);
  state.dashboardSeries = [...state.dashboardSeries.slice(-23), value];
}

function drawWaveChart() {
  if (!el.wavePath || !el.waveGlow) return;
  const width = 960;
  const height = 280;
  const padding = 20;
  const points = state.dashboardSeries.map((value, index, list) => {
    const x = padding + ((width - padding * 2) / Math.max(1, list.length - 1)) * index;
    const y = height - padding - ((height - padding * 2) * value / 100);
    return { x, y };
  });

  if (points.length < 2) return;

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = (previous.x + current.x) / 2;
    path += ` C ${midX} ${previous.y}, ${midX} ${current.y}, ${current.x} ${current.y}`;
  }

  el.wavePath.setAttribute("d", path);
  el.waveGlow.setAttribute("d", path);
}

function focusComposer() {
  if (state.ui.autoFocus && el.messageInput) {
    el.messageInput.focus();
  }
}

function isChatNearBottom() {
  const threshold = 80;
  return el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight <= threshold;
}

function syncNewMessagesButton() {
  const visible = state.unreadWhileDetached && !isChatNearBottom();
  el.newMessagesButton.classList.toggle("visible", visible);
}

function scrollChatToBottom(smooth = true) {
  el.chatLog.scrollTo({
    top: el.chatLog.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  });
}

function ingestFiles(fileList, kind) {
  const files = Array.from(fileList || []);
  files.forEach((file) => {
    const attachment = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      name: file.name,
      size: file.size,
      type: file.type,
      file,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : "",
    };
    state.attachments.push(attachment);
  });
  renderAttachments();
}

function renderAttachments() {
  if (!el.attachmentStrip) return;
  el.attachmentStrip.innerHTML = "";
  if (state.attachments.length === 0) {
    el.attachmentStrip.classList.remove("active");
    return;
  }
  el.attachmentStrip.classList.add("active");
  state.attachments.forEach((attachment) => {
    const item = document.createElement("div");
    item.className = "attachment-chip glass-subpanel";
    item.innerHTML = `
      ${attachment.previewUrl ? `<img src="${attachment.previewUrl}" alt="${escapeHtml(attachment.name)}">` : `<span class="attachment-kind">${escapeHtml(attachment.kind)}</span>`}
      <div class="attachment-copy">
        <strong>${escapeHtml(attachment.name)}</strong>
        <span>${formatFileSize(attachment.size)}</span>
      </div>
      <button class="attachment-remove" type="button" data-attachment-remove="${attachment.id}">×</button>
    `;
    el.attachmentStrip.appendChild(item);
  });

  el.attachmentStrip.querySelectorAll("[data-attachment-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      removeAttachment(button.getAttribute("data-attachment-remove") || "");
    });
  });
}

function removeAttachment(id) {
  const target = state.attachments.find((item) => item.id === id);
  if (target?.previewUrl) {
    URL.revokeObjectURL(target.previewUrl);
  }
  state.attachments = state.attachments.filter((item) => item.id !== id);
  renderAttachments();
}

function clearAttachments() {
  state.attachments.forEach((attachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
  state.attachments = [];
  renderAttachments();
}

function buildAttachmentSummary() {
  if (state.attachments.length === 0) return "";
  const lines = state.attachments.map((attachment) => {
    const kindLabel = attachment.kind === "image"
      ? "图片"
      : attachment.kind === "audio"
        ? "语音"
        : "文件";
    return `- ${kindLabel}: ${attachment.name} (${formatFileSize(attachment.size)})`;
  });
  return ["附件：", ...lines].join("\n");
}

async function toggleVoiceCapture() {
  if (state.voiceMode === "recording") {
    stopVoiceRecording();
    return;
  }
  if (await startSpeechRecognition()) {
    return;
  }
  await startVoiceRecording();
}

async function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return false;
  if (!state.recognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join("");
      el.messageInput.value = transcript.trim();
    };
    recognition.onend = () => {
      state.voiceMode = "idle";
      el.voiceButton.classList.remove("recording");
    };
    recognition.onerror = async () => {
      state.voiceMode = "idle";
      el.voiceButton.classList.remove("recording");
      await startVoiceRecording();
    };
    state.recognition = recognition;
  }
  state.voiceMode = "recording";
  el.voiceButton.classList.add("recording");
  state.recognition.start();
  return true;
}

async function startVoiceRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    appendSystemMessage("当前浏览器不支持语音录制，可改用图片或文件发送。");
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  state.recordingStream = stream;
  state.mediaRecorder = recorder;
  state.voiceMode = "recording";
  el.voiceButton.classList.add("recording");
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
    ingestFiles([file], "audio");
    stream.getTracks().forEach((track) => track.stop());
    state.mediaRecorder = null;
    state.recordingStream = null;
    state.voiceMode = "idle";
    el.voiceButton.classList.remove("recording");
  };
  recorder.start();
}

function stopVoiceRecording() {
  if (state.recognition && state.voiceMode === "recording") {
    try {
      state.recognition.stop();
    } catch {}
  }
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
  if (state.recordingStream) {
    state.recordingStream.getTracks().forEach((track) => track.stop());
    state.recordingStream = null;
  }
  state.voiceMode = "idle";
  el.voiceButton.classList.remove("recording");
}

function compactSessionOptions(sessions, currentSessionId, historySessionId) {
  const selectedIds = new Set([currentSessionId, historySessionId].filter(Boolean));
  const filtered = sessions.filter((session) => selectedIds.has(session.id));

  const deduped = [];
  const seen = new Set();
  for (const session of filtered) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    deduped.push(session);
  }
  return deduped.slice(0, 8);
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

function prettyValue(value) {
  if (!value) return "";
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(value);
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdown(source) {
  const escaped = escapeHtml(source || "");
  const blocks = escaped
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);

  const lines = blocks.split("\n");
  let html = "";
  let inList = false;

  lines.forEach((line) => {
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${line.replace(/^\s*[-*]\s+/, "")}</li>`;
      return;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    if (!line.trim()) {
      html += "<br>";
      return;
    }
    if (/^<h[1-3]>/.test(line) || /^<pre>/.test(line)) {
      html += line;
      return;
    }
    html += `<p>${line}</p>`;
  });

  if (inList) html += "</ul>";
  return html;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

boot().catch((error) => {
  console.error(error);
  setLiveState("error");
});
