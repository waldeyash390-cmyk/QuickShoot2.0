// app.js — multi-user entry point. No framework, plain DOM.

import { CryptoModule } from "./crypto.js";
import { Signaling } from "./signaling.js";
import { PeerMesh } from "./webrtc.js";
import { FileTransferManager } from "./filetransfer.js";

// ---------------------------------------------------------------- DOM refs
const $ = (id) => document.getElementById(id);

const els = {
  roomTag: $("roomTag"),
  toolsBtn: $("toolsBtn"),
  settingsBtn: $("settingsBtn"),

  screenHome: $("screenHome"),
  hostBtn: $("hostBtn"),
  joinForm: $("joinForm"),
  joinCodeInput: $("joinCodeInput"),
  homeError: $("homeError"),

  screenWaiting: $("screenWaiting"),
  waitingLabel: $("waitingLabel"),
  roomCodeBlock: $("roomCodeBlock"),
  roomCodeText: $("roomCodeText"),
  copyCodeBtn: $("copyCodeBtn"),
  copyCodeLabel: $("copyCodeLabel"),
  qrImg: $("qrImg"),
  qrWrap: $("qrWrap"),
  waitingHint: $("waitingHint"),
  cancelWaitBtn: $("cancelWaitBtn"),
  cancelWaitBtnHost: $("cancelWaitBtnHost"),
  joinLobby: $("joinLobby"),
  joinLobbyTitle: $("joinLobbyTitle"),
  joinLobbySub: $("joinLobbySub"),
  hostLobby: $("hostLobby"),
  setupState: $("setupState"),
  jstep1: $("jstep1"),
  jstep2: $("jstep2"),
  jstep3: $("jstep3"),

  screenChat: $("screenChat"),
  messages: $("messages"),
  peerCount: $("peerCount"),
  fileDrop: $("fileDrop"),
  fileInput: $("fileInput"),
  fileList: $("fileList"),
  composerForm: $("composerForm"),
  attachBtn: $("attachBtn"),
  cameraBtn: $("cameraBtn"),
  voiceBtn: $("voiceBtn"),
  callBtn: $("headerCallBtn"),
  headerVideoCallBtn: $("headerVideoCallBtn"),
  callNotification: $("callNotification"),
  callNotifSub: $("callNotifSub"),
  callAcceptBtn: $("callAcceptBtn"),
  callDeclineBtn: $("callDeclineBtn"),
  callActiveBar: $("callActiveBar"),
  callActiveLabel: $("callActiveLabel"),
  callActiveTimer: $("callActiveTimer"),
  callEndBtn: $("callEndBtn"),
  callRemoteAudio: $("callRemoteAudio"),
  cameraOverlay: $("cameraOverlay"),
  cameraCloseBtn: $("cameraCloseBtn"),
  cameraVideo: $("cameraVideo"),
  cameraCanvas: $("cameraCanvas"),
  cameraPreview: $("cameraPreview"),
  cameraFlash: $("cameraFlash"),
  cameraControls: $("cameraControls"),
  cameraFlipBtn: $("cameraFlipBtn"),
  cameraShutterBtn: $("cameraShutterBtn"),
  cameraRetakeRow: $("cameraRetakeRow"),
  cameraRetakeBtn: $("cameraRetakeBtn"),
  cameraSendPhotoBtn: $("cameraSendPhotoBtn"),
  messageInput: $("messageInput"),
  typingIndicator: $("typingIndicator"),

  settingsOverlay: $("settingsOverlay"),
  settingsConnState: $("settingsConnState"),
  settingsRoomCode: $("settingsRoomCode"),
  settingsTimer: $("settingsTimer"),
  themeToggleBtn: $("themeToggleBtn"),
  leaveBtn: $("leaveBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),

  leaveConfirmOverlay: $("leaveConfirmOverlay"),
  leaveCancelBtn: $("leaveCancelBtn"),
  leaveConfirmBtn: $("leaveConfirmBtn"),

  toast: $("toast"),
};

// ---------------------------------------------------------------- state
const state = {
  roomCode: null,
  myPeerId: null,
  signaling: null,
  mesh: null,         // PeerMesh replaces peerLink
  cryptoKey: null,
  fileTransfer: null,
  connectedAt: null,
    sentStatusElements: new Map(),
    unseenIncomingMsgIds: new Set(),
  myMsgCount: 0,
  // Track which peers are typing
  typingPeers: new Set(),
  // peerId -> display name ("Host" for the room creator, "U1","U2"... for joiners)
  peerNames: new Map(),
  myName: null,
  // Peers that were already in the room when we joined (don't announce them as "joined")
  existingPeerIds: new Set(),
  // Call state
  call: {
    active: false,
    isVideo: false,
    localStream: null,
    localVideoStream: null,
    peerConnections: new Map(), // peerId -> RTCPeerConnection
    callTimerHandle: null,
    callStartTime: null,
    incomingCallFrom: null,
    remoteVideoElements: new Map(),
  },
};

// ---------------------------------------------------------------- helpers
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function showScreen(name) {
  hide(els.screenHome);
  hide(els.screenWaiting);
  hide(els.screenChat);
  if (name === "home") show(els.screenHome);
  if (name === "waiting") show(els.screenWaiting);
  if (name === "chat") show(els.screenChat);
}

function setStatus(stateName, label) {
  els.settingsConnState.textContent = label;
}

function updatePeerCount() {
  if (!state.mesh) return;
  const n = state.mesh.connectedPeerCount();
  // n peers + me = n+1 total in room
  els.peerCount.textContent = `${n + 1} in room`;
}

function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  show(els.toast);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(els.toast), ms);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function normalizeCode(raw) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function resetToHome() {
  showScreen("home");
  setStatus("offline", "Offline");
  hide(els.roomTag);
  hide(els.peerCount);
    hide(els.settingsBtn);
    hide(els.toolsBtn);
    hide(els.callBtn);
    hide(els.headerVideoCallBtn);
  els.messages.innerHTML = "";
  // Reset any pending read‑receipt tracking for messages that were cleared
  state.unseenIncomingMsgIds.clear();
  els.fileList.innerHTML = "";
  els.joinCodeInput.value = "";
  hide(els.homeError);
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.roomCode = null;
  state.myPeerId = null;
  state.mesh = null;
  state.cryptoKey = null;
  state.fileTransfer = null;
  state.connectedAt = null;
  state.typingPeers.clear();
  state.peerNames.clear();
  state.existingPeerIds.clear();
  state.myName = null;
  updateTypingIndicator();
  callCleanup();
}

// ---------------------------------------------------------------- host flow
async function startHosting() {
  const passphrase = document.getElementById("hostPassphraseInput")?.value.trim() || null;
  showScreen("waiting");
  // Show setup spinner while connecting
  show(els.setupState);
  hide(els.hostLobby);
  hide(els.joinLobby);
  els.waitingLabel.textContent = "Setting up your room…";
  hide(els.roomCodeBlock);
  if (els.qrWrap) hide(els.qrWrap);
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => state.signaling.send({ type: "host", passphrase }));
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

async function startJoining(code) {
  const passphrase = document.getElementById("joinPassphraseInput")?.value.trim() || null;
  state.roomCode = code;
  showScreen("waiting");
  // Show join lobby UI
  hide(els.setupState);
  hide(els.hostLobby);
  show(els.joinLobby);
  els.joinLobbyTitle.textContent = `Joining ${code}`;
  els.joinLobbySub.textContent = "Connecting securely…";
  // Animate steps
  setJoinStep(1);
  setStatus("connecting", "Connecting…");

  state.signaling = new Signaling();
  state.signaling.addEventListener("open", () => {
    setJoinStep(2);
    els.joinLobbySub.textContent = "Verifying room…";
    state.signaling.send({ type: "join", code, passphrase });
  });
  state.signaling.addEventListener("message", (e) => handleSignalingMessage(e.detail));
  state.signaling.connect();
}

function setJoinStep(n) {
  [els.jstep1, els.jstep2, els.jstep3].forEach((el, i) => {
    if (!el) return;
    const dot = el.querySelector(".join-step-dot");
    if (i < n - 1) { dot.className = "join-step-dot done"; }
    else if (i === n - 1) { dot.className = "join-step-dot active"; }
    else { dot.className = "join-step-dot"; }
  });
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {

    case "hosted": {
      state.roomCode = msg.code;
      state.myPeerId = msg.peerId;
      state.myName = msg.name || "Host";
      state.peerNames.set(state.myPeerId, state.myName);
      els.roomCodeText.textContent = msg.code;
      // Switch from setup spinner to host lobby
      hide(els.setupState);
      hide(els.joinLobby);
      show(els.hostLobby);
      show(els.roomCodeBlock);
      if (els.waitingHint) els.waitingHint.textContent = "Waiting for someone to join…";
      const shareUrl = `${location.origin}${location.pathname}?code=${encodeURIComponent(msg.code)}`;
      els.qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&qzone=1&data=${encodeURIComponent(shareUrl)}`;
      if (els.qrWrap) show(els.qrWrap);
      // Host creates the mesh but waits for first peer before entering chat
      state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
      state.mesh = new PeerMesh(state.signaling, state.myPeerId);
      wireMeshEvents();
      // DO NOT call onFirstConnect() here — host waits on the lobby until a user joins
      break;
    }

    case "joined": {
      state.myPeerId = msg.peerId;
      state.roomCode = msg.code;
      state.myName = msg.name || "U?";
      state.peerNames.set(state.myPeerId, state.myName);
      for (const p of msg.peers || []) {
        state.peerNames.set(p.peerId, p.name);
        state.existingPeerIds.add(p.peerId); // mark as pre-existing, not "new joiners"
      }
      state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
      state.mesh = new PeerMesh(state.signaling, state.myPeerId);
      wireMeshEvents();
      // Connect to every peer already in the room
      if (msg.peers.length > 0) {
        await state.mesh.connectToExistingPeers(msg.peers.map((p) => p.peerId));
      } else {
        // Room was empty (e.g. host left, room not destroyed yet — shouldn't normally happen)
        onFirstConnect();
      }
      break;
    }

    case "peer-joined": {
      // Someone new entered; as the existing user we don't initiate — they do
      state.peerNames.set(msg.peerId, msg.name || msg.peerId.slice(0, 4).toUpperCase());
      if (state.mesh) {
        await state.mesh.acceptNewPeer(msg.peerId);
        // If host is still on waiting screen (hasn't entered chat yet), transition now
        if (els.screenWaiting && !els.screenWaiting.hidden) {
          // Animate step 3 if join lobby visible (for joiner path), or just enter chat
          onFirstConnect();
        }
      }
      break;
    }

    case "peer-left": {
      if (state.mesh) {
        const leftName = msg.name || state.peerNames.get(msg.peerId) || "A user";
        state.mesh.removePeer(msg.peerId);
        addSystemMessage(`${leftName} left the room.`);
        state.peerNames.delete(msg.peerId);
        state.typingPeers.delete(msg.peerId);
        updateTypingIndicator();
        updatePeerCount();
      }
      break;
    }

    case "error": {
      // Show server‑sent error (e.g. room full) on the join screen
      toast(msg.message);
      els.homeError.textContent = msg.message;
      show(els.homeError);
      // If we are on the join screen, keep us there; otherwise return home
      if (els.joinForm && !els.joinForm.hidden) {
        // stay on join screen – error already displayed
      } else {
        cleanupConnection();
        resetToHome();
      }
    }

    case "room-closed": {
      toast("Session ended — room closed.");
      cleanupConnection();
      showScreen("home");
      break;
    }

    default:
      break; // signal messages are consumed by PeerMesh internals
  }
}

let _firstConnectDone = false;

function onFirstConnect() {
  if (_firstConnectDone) return;
  _firstConnectDone = true;
  state.connectedAt = Date.now();
  state.fileTransfer = new FileTransferManager(state.mesh, state.cryptoKey);
  wireFileTransferEvents();

  showScreen("chat");
  els.roomTag.textContent = state.roomCode;
  show(els.roomTag);
  show(els.peerCount);
  show(els.settingsBtn);
  show(els.toolsBtn);
  show(els.callBtn);
  show(els.headerVideoCallBtn);
  els.settingsRoomCode.textContent = state.roomCode;
  setStatus("online", "Connected");
  if (state.myName === "Host") {
    addSystemMessage("Room created. Share the code for others to join!");
  } else {
    addSystemMessage(`You joined as ${state.myName}. Welcome!`);
  }
  updatePeerCount();

  state.timerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - state.connectedAt) / 1000);
    const clock = formatClock(secs);
    els.settingsTimer.textContent = clock;
  }, 1000);
}

function wireMeshEvents() {
  state.mesh.addEventListener("state", (e) => {
    if (e.detail === "connected") {
      // If joiner lobby is visible, animate step 3 then enter
      if (els.joinLobby && !els.joinLobby.hidden) {
        setJoinStep(3);
        els.joinLobbySub.textContent = "Almost there…";
        setTimeout(() => { onFirstConnect(); updatePeerCount(); }, 700);
      } else {
        onFirstConnect();
        updatePeerCount();
      }
    }
    if (["disconnected", "failed", "closed"].includes(e.detail)) {
      setStatus("offline", "Disconnected");
    }
  });

  state.mesh.addEventListener("peer-state", (e) => {
    const { peerId, state: peerState } = e.detail;
    if (peerState === "connected") {
      // Only announce peers that joined AFTER us, not ones already in the room
      if (!state.existingPeerIds.has(peerId)) {
        const joinedName = state.peerNames.get(peerId) || "A new user";
        addSystemMessage(`${joinedName} joined the room.`);
      }
      updatePeerCount();
    }
  });

  state.mesh.addEventListener("rtt", (e) => updateQuality(e.detail));

  state.mesh.addEventListener("data", (e) => {
    if (e.detail.kind === "chat") onChatData(e.detail.data, e.detail.peerId);
  });
}

function onDisconnected() {
  setStatus("offline", "Disconnected");
  addSystemMessage("Connection lost. The other person may have left.");
}

function cleanupConnection() {
  _firstConnectDone = false;
  if (state.mesh) state.mesh.close();
  if (state.signaling) state.signaling.close();
  if (state.timerHandle) clearInterval(state.timerHandle);
}

function updateQuality(rttMs) {
  let level = 0;
  if (rttMs < 100) level = 4;
  else if (rttMs < 250) level = 3;
  else if (rttMs < 500) level = 2;
  else if (rttMs < 1000) level = 1;
  const el = document.getElementById("qualityIndicator");
  if (el) {
    el.dataset.level = level;
    el.title = `${rttMs}ms`;
  }
}

// ---------------------------------------------------------------- chat
function renderMarkdown(text) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, text) => `<h${hashes.length}>${text}</h${hashes.length}>`)
    .replace(/^\*\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

function addMessage({ text, mine, ts, senderLabel, msgId }) {
  const div = document.createElement("div");
  div.className = `msg ${mine ? "me" : ""}`;
  div.dataset.msgId = msgId;

  const copyBtn = document.createElement("button");
  copyBtn.className = "msg-copy-btn";
  copyBtn.title = "Copy message";
  copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      copyBtn.classList.remove("copied");
    }, 1500);
  });

  const body = document.createElement("div");
  body.className = "body";
  body.innerHTML = renderMarkdown(text);

  const meta = document.createElement("div");
  meta.className = "meta";
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = mine ? time : `${senderLabel || "Peer"} · ${time}`;

  const status = document.createElement("span");
  status.className = "msg-status";
  status.textContent = "Sent";
  if (mine && msgId) {
    state.sentStatusElements.set(msgId, status);
  }

  const contentWrap = document.createElement("div");
  contentWrap.className = "msg-content";
  contentWrap.append(body, meta);

  if (mine) {
    div.append(contentWrap, status, copyBtn);
  } else {
    if (msgId) {
      state.unseenIncomingMsgIds.add(msgId);
      if (typeof visibilityObserver !== "undefined") visibilityObserver.observe(div);
    }
    div.append(contentWrap, copyBtn);
  }

  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function updateTypingIndicator() {
  if (state.typingPeers.size > 0) {
    const n = state.typingPeers.size;
    els.typingIndicator.textContent = n === 1 ? "Someone is typing…" : `${n} people are typing…`;
    show(els.typingIndicator);
  } else {
    hide(els.typingIndicator);
  }
}

// ------------------------------------------------------------ read‑receipt helpers
/**
 * Send a "seen" payload containing message IDs that have been observed.
 * Only sends when the document is visible.
 * @param {string[]} ids
 */
function sendSeen(ids) {
  if (!ids || ids.length === 0) return;
  if (document.visibilityState !== "visible") return;
  broadcastChatPayload({ t: "seen", ids });
}

/**
 * IntersectionObserver that watches incoming message elements.
 * When an incoming message becomes visible while the tab is active, we send a "seen"
 * notification for that message ID and stop observing it.
 */
const visibilityObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    if (document.visibilityState !== "visible") continue;
    const el = entry.target;
    const id = el.dataset.msgId;
    if (id && state.unseenIncomingMsgIds.has(id)) {
      sendSeen([id]);
      // No longer need to watch this element
      visibilityObserver.unobserve(el);
      state.unseenIncomingMsgIds.delete(id);
    }
  }
});

async function broadcastChatPayload(obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.broadcast("chat", encrypted.buffer.slice(0));
}


async function onChatData(rawArrayBuffer, fromPeerId) {
  const msg = await CryptoModule.decryptJSON(state.cryptoKey, rawArrayBuffer);
  const label = state.peerNames.get(fromPeerId) || fromPeerId.slice(0, 4).toUpperCase();

    if (msg.t === "msg") {
      addMessage({ text: msg.text, mine: false, ts: msg.ts, senderLabel: label, msgId: msg.msgId });
      state.typingPeers.delete(fromPeerId);
      updateTypingIndicator();
    } else if (msg.t === "seen") {
      // msg.ids is an array of message IDs that the remote peer has seen
      if (Array.isArray(msg.ids)) {
        msg.ids.forEach((id) => {
          const statusElem = state.sentStatusElements.get(id);
          if (statusElem) {
            statusElem.textContent = "Seen";
            statusElem.classList.add("seen");
          }
        });
      }
    } else if (msg.t === "typing") {
    if (msg.state) state.typingPeers.add(fromPeerId);
    else state.typingPeers.delete(fromPeerId);
    updateTypingIndicator();
  } else if (msg.t === "call-invite") {
    callHandleInvite(fromPeerId, label, msg.video === true);
  } else if (msg.t === "call-accept") {
    callHandleAccept(fromPeerId);
  } else if (msg.t === "call-decline") {
    callHandleDecline(fromPeerId);
  } else if (msg.t === "call-end") {
    callHandleRemoteEnd(fromPeerId);
  } else if (msg.t === "call-signal") {
    callHandleSignal(fromPeerId, msg.payload);
  }
}

let typingTimeout = null;
els.messageInput.addEventListener("input", () => {
  if (!state.mesh) return;
  broadcastChatPayload({ t: "typing", state: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => broadcastChatPayload({ t: "typing", state: false }), 1500);

  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${els.messageInput.scrollHeight}px`;
});

// Keep --composer-h in sync with the fixed composer's real rendered height,
// so the chat area always reserves exactly enough space and content never
// hides behind it (handles the textarea growing, safe-area insets, etc).
if (typeof ResizeObserver !== "undefined") {
  const syncComposerHeight = () => {
    document.documentElement.style.setProperty(
      "--composer-h",
      `${els.composerForm.offsetHeight}px`
    );
  };
  new ResizeObserver(syncComposerHeight).observe(els.composerForm);
  syncComposerHeight();
}

els.composerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
    if (!text || !state.mesh) return;

    const ts = Date.now();
    const msgId = `${state.myPeerId}-${ts}`;
    await broadcastChatPayload({ t: "msg", text, ts, msgId });
    addMessage({ text, mine: true, ts, msgId });

  els.messageInput.value = "";
  els.messageInput.style.height = "auto";
  clearTimeout(typingTimeout);
  broadcastChatPayload({ t: "typing", state: false });
});

els.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composerForm.requestSubmit();
  }
});

// Global keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
  if (e.key === "/") { e.preventDefault(); els.messageInput?.focus(); }
  if (e.key === "Escape") {
    if (!els.settingsOverlay.hidden) hide(els.settingsOverlay);
    if (!els.leaveConfirmOverlay.hidden) hide(els.leaveConfirmOverlay);
    if (!els.cameraOverlay.hidden) { if (typeof cameraHide === "function") cameraHide(); }
    if (!els.toolsOverlay.hidden) hide(els.toolsOverlay);
    if (!els.convOverlay.classList.contains("open")) hide(els.convOverlay);
  }
});

// ---------------------------------------------------------------- files
function formatSpeed(bps) {
  if (!bps || bps <= 0) return "";
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

// Professional SVG icons
const ICONS = {
  attach: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`,
  camera: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="12" r="4"></circle></svg>`,
  mic: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>`,
  micActive: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>`,
  call: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.56a16 16 0 0 0 6.29 6.29l1.63-1.84a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`,
  videoCall: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  volume: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  pause: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  upload: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  download: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  fileImage: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
  fileVideo: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  fileAudio: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5v14"></path><path d="M19 9v6"></path><path d="M3 17v-6"></path><path d="M9 3v18"></path></svg>`,
  filePdf: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  fileDoc: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  fileArchive: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line><path d="M20 19H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10"></path></svg>`,
  fileCode: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
  fileDefault: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
  send: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
  callEnd: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 3.86a10 10 0 0 1 12.54 12.54"></path><path d="M13.82 19.22a10 10 0 0 1-3.74-3.74"></path><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  callActive: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle></svg>`,
  videoIcon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
};

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["jpg","jpeg","png","gif","webp","svg","bmp","heic"].includes(ext)) return ICONS.fileImage;
  if (["mp4","mov","avi","mkv","webm","flv"].includes(ext)) return ICONS.fileVideo;
  if (["mp3","wav","ogg","flac","aac","m4a"].includes(ext)) return ICONS.fileAudio;
  if (["pdf"].includes(ext)) return ICONS.filePdf;
  if (["doc","docx","txt","md","rtf"].includes(ext)) return ICONS.fileDoc;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return ICONS.fileArchive;
  if (["js","ts","jsx","tsx","html","css","json","py","java","cpp","c","h"].includes(ext)) return ICONS.fileCode;
  return ICONS.fileDefault;
}

function formatEta(sec) {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m left`;
}

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["jpg","jpeg","png","gif","webp","svg","bmp","heic"].includes(ext)) return "🖼";
  if (["mp4","mov","avi","mkv","webm","flv"].includes(ext)) return "🎬";
  if (["mp3","wav","ogg","flac","aac","m4a"].includes(ext)) return "🎵";
  if (["pdf"].includes(ext)) return "📄";
  if (["doc","docx","txt","md","rtf"].includes(ext)) return "📝";
  if (["zip","rar","7z","tar","gz"].includes(ext)) return "📦";
  if (["js","ts","jsx","tsx","html","css","json","py","java","cpp","c","h"].includes(ext)) return "💻";
  return "📎";
}

// Build a rich file-item row and return refs to its updatable parts
function createFileItem({ id, name, size, direction }) {
  const icon = getFileIcon(name);
  const li = document.createElement("li");
  li.className = "file-item file-item--active";
  li.id = `file-${id}`;
  li.innerHTML = `
    <div class="fi-top">
      <span class="fi-arrow">${direction === "up" ? "↑" : "↓"}</span>
      <span class="fi-icon">${icon}</span>
      <span class="fi-name">${escapeHtml(name)}</span>
      <span class="fi-size">${formatBytes(size)}</span>
    </div>
    <div class="fi-bar-wrap">
      <progress class="fi-progress" max="100" value="0"></progress>
    </div>
    <div class="fi-bottom">
      <span class="fi-pct">0%</span>
      <span class="fi-speed"></span>
      <span class="fi-eta"></span>
      <span class="fi-spacer"></span>
      ${direction === "up" ? `
        <button class="fi-btn fi-pause" title="Pause">${ICONS.pause}</button>
        <button class="fi-btn fi-cancel" title="Cancel">${ICONS.close}</button>
      ` : `
        <button class="fi-btn fi-cancel" title="Cancel">${ICONS.close}</button>
      `}
    </div>`;
  els.fileList.appendChild(li);

  return {
    li,
    progress: li.querySelector(".fi-progress"),
    pct:      li.querySelector(".fi-pct"),
    speed:    li.querySelector(".fi-speed"),
    eta:      li.querySelector(".fi-eta"),
    pauseBtn: li.querySelector(".fi-pause"),
    cancelBtn:li.querySelector(".fi-cancel"),
  };
}

function wireFileTransferEvents() {
  const ft = state.fileTransfer;

  // Track pause state per outgoing transfer id
  const pausedIds = new Set();

  ft.addEventListener("queued", (e) => {
    const { id, name, size } = e.detail;
    const refs = createFileItem({ id, name, size, direction: "up" });

    if (refs.pauseBtn) {
      refs.pauseBtn.addEventListener("click", () => {
        if (pausedIds.has(id)) {
          // Resume
          pausedIds.delete(id);
          refs.pauseBtn.innerHTML = ICONS.pause;
          refs.pauseBtn.title = "Pause";
          refs.li.classList.remove("file-item--paused");
          if (ft.resumeIfNeeded) ft.resumeIfNeeded();
        } else {
          // Pause
          pausedIds.add(id);
          refs.pauseBtn.textContent = "▶";
          refs.pauseBtn.title = "Resume";
          refs.li.classList.add("file-item--paused");
          refs.eta.textContent = "Paused";
          refs.speed.textContent = "";
        }
      });
    }

    if (refs.cancelBtn) {
      refs.cancelBtn.addEventListener("click", () => {
        if (ft.cancel) ft.cancel(id);
        refs.li.remove();
        pausedIds.delete(id);
      });
    }
  });

  ft.addEventListener("send-progress", (e) => {
    const { id, sent, total, speedBps, etaSec } = e.detail;
    if (pausedIds.has(id)) return;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const pct = Math.round((sent / total) * 100);
    li.querySelector(".fi-progress").value = pct;
    li.querySelector(".fi-pct").textContent  = `${pct}%`;
    li.querySelector(".fi-speed").textContent = formatSpeed(speedBps);
    li.querySelector(".fi-eta").textContent   = formatEta(etaSec);
  });

  ft.addEventListener("send-complete", (e) => {
    const li = document.getElementById(`file-${e.detail.id}`);
    if (!li) return;
    li.querySelector(".fi-progress").value   = 100;
    li.querySelector(".fi-pct").textContent  = "100%";
    li.querySelector(".fi-speed").textContent = "";
    li.querySelector(".fi-eta").innerHTML   = `Sent ${ICONS.check}`;
    li.querySelector(".fi-bottom").querySelectorAll(".fi-btn").forEach(b => b.remove());
    li.classList.remove("file-item--active", "file-item--paused");
    li.classList.add("file-item--done");
  });

  ft.addEventListener("receive-start", (e) => {
    const { id, name, size } = e.detail;
    const refs = createFileItem({ id, name, size, direction: "down" });

    if (refs.cancelBtn) {
      refs.cancelBtn.addEventListener("click", () => {
        // Can't truly cancel a WebRTC receive mid-stream, just hide it
        refs.li.remove();
      });
    }
  });

  ft.addEventListener("receive-progress", (e) => {
    const { id, received, total, speedBps, etaSec } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const pct = Math.round((received / total) * 100);
    li.querySelector(".fi-progress").value   = pct;
    li.querySelector(".fi-pct").textContent  = `${pct}%`;
    li.querySelector(".fi-speed").textContent = formatSpeed(speedBps);
    li.querySelector(".fi-eta").textContent   = formatEta(etaSec);
  });

  ft.addEventListener("receive-complete", (e) => {
    const { id, name, blob } = e.detail;
    const li = document.getElementById(`file-${id}`);
    if (!li) return;
    const url = URL.createObjectURL(blob);

    li.classList.remove("file-item--active");
    li.classList.add("file-item--done");
    li.innerHTML = `
      <div class="fi-top">
        <span class="fi-arrow fi-arrow--done">↓</span>
        <span class="fi-name">${escapeHtml(name)}</span>
        <span class="fi-size">${formatBytes(blob.size)}</span>
      </div>
      <div class="fi-bottom">
        <span class="fi-eta fi-done-label">Done ${ICONS.check}</span>
        <span class="fi-spacer"></span>
        <a class="fi-btn fi-dl-btn" href="${url}" download="${escapeHtml(name)}">${ICONS.download} Download</a>
      </div>`;

    li.querySelector(".fi-dl-btn").addEventListener("click", () => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  });

  ft.addEventListener("receive-cancelled", (e) => {
    const li = document.getElementById(`file-${e.detail.id}`);
    if (li) li.remove();
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length && state.fileTransfer) {
    state.fileTransfer.enqueue([...els.fileInput.files]);
  }
  els.fileInput.value = "";
});
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  els.fileDrop.classList.add('dragover');
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    els.fileDrop.classList.remove('dragover');
    dragCounter = 0;
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  els.fileDrop.classList.remove('dragover');
  if (e.dataTransfer.files.length && state.fileTransfer) {
    state.fileTransfer.enqueue([...e.dataTransfer.files]);
  }
});

els.messageInput.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find((i) => i.type.startsWith("image/"));
  if (imageItem && state.fileTransfer) {
    const file = imageItem.getAsFile();
    if (file) state.fileTransfer.enqueue([file]);
  }
});

// Voice recording
const voiceState = { mediaRecorder: null, chunks: [], stream: null, recording: false };

async function voiceStart() {
  if (voiceState.recording) return;
  try {
    voiceState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceState.mediaRecorder = new MediaRecorder(voiceState.stream, { mimeType: "audio/webm" });
    voiceState.chunks = [];
    voiceState.mediaRecorder.ondataavailable = (e) => { if (e.data.size) voiceState.chunks.push(e.data); };
    voiceState.mediaRecorder.onstop = async () => {
      const blob = new Blob(voiceState.chunks, { type: "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
      if (state.fileTransfer) state.fileTransfer.enqueue([file]);
      voiceState.stream?.getTracks().forEach(t => t.stop());
      voiceState.stream = null;
      voiceState.recording = false;
      els.voiceBtn.classList.remove("recording");
      els.voiceBtn.title = "Record voice message";
    };
    voiceState.mediaRecorder.start();
    voiceState.recording = true;
    els.voiceBtn.classList.add("recording");
    els.voiceBtn.title = "Stop recording";
  } catch (err) {
    console.error("Voice recording failed:", err);
    toast("Microphone access denied");
  }
}

function voiceStop() {
  if (voiceState.mediaRecorder && voiceState.recording) {
    voiceState.mediaRecorder.stop();
  }
}

els.voiceBtn?.addEventListener("click", () => {
  if (!state.fileTransfer) return;
  if (voiceState.recording) voiceStop();
  else voiceStart();
});

// ---------------------------------------------------------------- home UI
els.hostBtn.addEventListener("click", startHosting);

els.joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode(els.joinCodeInput.value.trim());
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    els.homeError.textContent = "Enter the 4-character room code (e.g. OKT3).";
    show(els.homeError);
    return;
  }
  hide(els.homeError);
  startJoining(code);
});

els.joinCodeInput.addEventListener("input", () => {
  els.joinCodeInput.value = normalizeCode(els.joinCodeInput.value);
});

els.copyCodeBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.roomCode);
    if (els.copyCodeLabel) {
      els.copyCodeLabel.textContent = "Copied!";
      els.copyCodeBtn.classList.add("copied");
      setTimeout(() => {
        if (els.copyCodeLabel) els.copyCodeLabel.textContent = "Copy";
        els.copyCodeBtn.classList.remove("copied");
      }, 2000);
    }
    toast("Room code copied.");
  } catch(e) { toast("Couldn't copy — try manually."); }
});

els.cancelWaitBtn.addEventListener("click", () => {
  cleanupConnection();
  resetToHome();
});

if (els.cancelWaitBtnHost) {
  els.cancelWaitBtnHost.addEventListener("click", () => {
    cleanupConnection();
    resetToHome();
  });
}

const prefillCode = new URLSearchParams(location.search).get("code");
if (prefillCode) els.joinCodeInput.value = normalizeCode(prefillCode);

// ---------------------------------------------------------------- settings & leave
els.settingsBtn.addEventListener("click", () => show(els.settingsOverlay));
els.closeSettingsBtn.addEventListener("click", () => hide(els.settingsOverlay));
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) hide(els.settingsOverlay);
});

// ---------------------------------------------------------------- theme toggle
const THEME_KEY = "qs-theme";

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    els.themeToggleBtn.textContent = "☀️ Light";
  } else {
    document.documentElement.removeAttribute("data-theme");
    els.themeToggleBtn.textContent = "🌙 Dark";
  }
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  applyTheme(saved === "light" ? "light" : "dark");
})();

els.themeToggleBtn.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
});

els.leaveBtn.addEventListener("click", () => {
  hide(els.settingsOverlay);
  show(els.leaveConfirmOverlay);
});
els.leaveCancelBtn.addEventListener("click", () => hide(els.leaveConfirmOverlay));
els.leaveConfirmBtn.addEventListener("click", () => {
  state.signaling?.send({ type: "leave" });
  cleanupConnection();
  hide(els.leaveConfirmOverlay);
  resetToHome();
  toast("Session ended.");
});

window.addEventListener("beforeunload", () => {
  state.signaling?.send({ type: "leave" });
});

// ---------------------------------------------------------------- init
resetToHome();

// ================================================================
// CAMERA FEATURE
// ================================================================

const camera = {
  stream: null,
  facingMode: "environment", // start with rear cam
  capturedBlob: null,
};

function cameraShow() {
  els.cameraOverlay.removeAttribute("hidden");
  els.cameraPreview.setAttribute("hidden", "");
  els.cameraPreview.src = "";
  els.cameraRetakeRow.setAttribute("hidden", "");
  els.cameraControls.removeAttribute("hidden");
  camera.capturedBlob = null;
  cameraStart();
}

function cameraHide() {
  cameraStop();
  els.cameraOverlay.setAttribute("hidden", "");
  els.cameraPreview.setAttribute("hidden", "");
  els.cameraPreview.src = "";
  els.cameraRetakeRow.setAttribute("hidden", "");
  els.cameraControls.removeAttribute("hidden");
  camera.capturedBlob = null;
}

async function cameraStart() {
  cameraStop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camera.facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    camera.stream = stream;
    els.cameraVideo.srcObject = stream;
    els.cameraVideo.removeAttribute("hidden");
  } catch (err) {
    els.cameraVideo.setAttribute("hidden", "");
    const vf = document.getElementById("cameraViewfinder");
    vf.innerHTML = `
      <div class="camera-error">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Camera access denied or unavailable.<br>Please allow camera permissions and try again.
      </div>`;
  }
}

function cameraStop() {
  if (camera.stream) {
    camera.stream.getTracks().forEach((t) => t.stop());
    camera.stream = null;
  }
  els.cameraVideo.srcObject = null;
}

function cameraCapture() {
  const video = els.cameraVideo;
  const canvas = els.cameraCanvas;
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 960;
  const ctx = canvas.getContext("2d");
  // Mirror front camera capture
  if (camera.facingMode === "user") {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Flash effect
  const flash = els.cameraFlash;
  flash.classList.remove("flash-off");
  flash.classList.add("flash-on");
  requestAnimationFrame(() => {
    flash.classList.remove("flash-on");
    flash.classList.add("flash-off");
  });

  canvas.toBlob(
    (blob) => {
      camera.capturedBlob = blob;
      const url = URL.createObjectURL(blob);
      els.cameraPreview.src = url;
      els.cameraPreview.removeAttribute("hidden");
      cameraStop();
      els.cameraVideo.setAttribute("hidden", "");
      els.cameraControls.setAttribute("hidden", "");
      els.cameraRetakeRow.removeAttribute("hidden");
    },
    "image/jpeg",
    0.92
  );
}

async function cameraSendPhoto() {
  if (!camera.capturedBlob || !state.fileTransfer) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = new File([camera.capturedBlob], `photo-${ts}.jpg`, { type: "image/jpeg" });
  state.fileTransfer.enqueue([file]);
  cameraHide();
}

// Event listeners
els.cameraBtn.addEventListener("click", () => {
  if (!state.fileTransfer) return; // only usable in active session
  cameraShow();
});

els.cameraCloseBtn.addEventListener("click", cameraHide);
els.cameraOverlay.addEventListener("click", (e) => {
  if (e.target === els.cameraOverlay) cameraHide();
});

els.cameraShutterBtn.addEventListener("click", cameraCapture);

els.cameraFlipBtn.addEventListener("click", () => {
  camera.facingMode = camera.facingMode === "environment" ? "user" : "environment";
  // Mirror live view for front cam
  els.cameraVideo.style.transform = camera.facingMode === "user" ? "scaleX(-1)" : "";
  cameraStart();
});

els.cameraRetakeBtn.addEventListener("click", () => {
  if (camera.capturedBlob) {
    URL.revokeObjectURL(els.cameraPreview.src);
    camera.capturedBlob = null;
  }
  els.cameraPreview.setAttribute("hidden", "");
  els.cameraPreview.src = "";
  els.cameraRetakeRow.setAttribute("hidden", "");
  els.cameraControls.removeAttribute("hidden");
  // Rebuild viewfinder if error replaced it
  const vf = document.getElementById("cameraViewfinder");
  if (!vf.contains(els.cameraVideo)) {
    vf.innerHTML = "";
    vf.appendChild(els.cameraVideo);
    vf.appendChild(els.cameraCanvas);
    vf.appendChild(els.cameraPreview);
    vf.appendChild(els.cameraFlash);
  }
  els.cameraVideo.removeAttribute("hidden");
  cameraStart();
});

els.cameraSendPhotoBtn.addEventListener("click", cameraSendPhoto);

// ================================================================
// CALL FEATURE
// ================================================================

const CALL_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Video call state
const state.call = {
  ...state.call,
  isVideo: false,
  localVideoStream: null,
  remoteVideoElements: new Map(),
};

// --- helpers ---
function callIsActive() { return state.call.active; }

function callShowNotification(peerLabel, isVideo = false) {
  els.callNotifSub.textContent = `${peerLabel} is ${isVideo ? "video " : ""}calling…`;
  els.callNotification.removeAttribute("hidden");
  // Update accept button to show video icon if video call
  const acceptBtn = document.getElementById("callAcceptBtn");
  if (acceptBtn) {
    acceptBtn.innerHTML = isVideo ? ICONS.videoCall : ICONS.check;
  }
}
function callHideNotification() {
  els.callNotification.setAttribute("hidden", "");
}
function callShowActiveBar(label) {
  els.callActiveLabel.textContent = label || "Call active";
  els.callActiveBar.removeAttribute("hidden");
  document.body.classList.add("call-bar-active");
}
function callHideActiveBar() {
  els.callActiveBar.setAttribute("hidden", "");
  document.body.classList.remove("call-bar-active");
}
function callStartTimer() {
  state.call.callStartTime = Date.now();
  if (state.call.callTimerHandle) clearInterval(state.call.callTimerHandle);
  state.call.callTimerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - state.call.callStartTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toString().padStart(2, "0");
    els.callActiveTimer.textContent = `${m}:${s}`;
  }, 1000);
}
function callStopTimer() {
  if (state.call.callTimerHandle) clearInterval(state.call.callTimerHandle);
  state.call.callTimerHandle = null;
  els.callActiveTimer.textContent = "0:00";
}

// Broadcast a call-typed chat payload to all peers
async function callBroadcast(obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.broadcast("chat", encrypted.buffer.slice(0));
}
async function callSendTo(peerId, obj) {
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.sendTo(peerId, "chat", encrypted.buffer.slice(0));
}

// --- WebRTC peer connection (audio + optional video) ---
async function callCreatePC(remotePeerId, isInitiator, withVideo = false) {
  const pc = new RTCPeerConnection({ iceServers: CALL_ICE });

  // Add local audio tracks
  if (state.call.localStream) {
    state.call.localStream.getTracks().forEach(t => pc.addTrack(t, state.call.localStream));
  }
  // Add local video tracks
  if (withVideo && state.call.localVideoStream) {
    state.call.localVideoStream.getTracks().forEach(t => pc.addTrack(t, state.call.localVideoStream));
  }

  // Handle remote tracks
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    const hasVideo = stream.getVideoTracks().length > 0;
    if (hasVideo) {
      // Create video element for remote peer
      let videoEl = state.call.remoteVideoElements.get(remotePeerId);
      if (!videoEl) {
        videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;background:#000;border-radius:12px;";
        state.call.remoteVideoElements.set(remotePeerId, videoEl);
        // Add to call active bar video container
        const container = document.getElementById("callVideoContainer");
        if (container) container.appendChild(videoEl);
      }
      videoEl.srcObject = stream;
    } else {
      els.callRemoteAudio.srcObject = stream;
    }
  };

  // ICE → send via encrypted chat channel
  pc.onicecandidate = async (e) => {
    if (e.candidate) {
      await callSendTo(remotePeerId, { t: "call-signal", payload: { candidate: e.candidate } });
    }
  };

  state.call.peerConnections.set(remotePeerId, pc);

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await callSendTo(remotePeerId, { t: "call-signal", payload: { sdp: pc.localDescription, video: withVideo } });
  }
  return pc;
}

async function callHandleSignal(fromPeerId, payload) {
  let pc = state.call.peerConnections.get(fromPeerId);
  const withVideo = payload.video === true;
  if (!pc) {
    // We just accepted the call; create PC as non-initiator
    pc = await callCreatePC(fromPeerId, false, withVideo);
  }
  const { sdp, candidate } = payload;
  if (sdp) {
    await pc.setRemoteDescription(sdp);
    if (sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await callSendTo(fromPeerId, { t: "call-signal", payload: { sdp: pc.localDescription } });
    }
  } else if (candidate) {
    try { await pc.addIceCandidate(candidate); } catch { /* benign */ }
  }
}

// --- Call flow ---

// Caller: starts an audio call
async function callStart() {
  if (!state.mesh || state.mesh.connectedPeerCount() === 0) {
    toast("No one else is in the room.");
    return;
  }
  if (callIsActive()) {
    toast("Already in a call.");
    return;
  }
  try {
    state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.call.isVideo = false;
  } catch {
    toast("Microphone access denied.");
    return;
  }
  await callBroadcast({ t: "call-invite", video: false });
  state.call.active = true;
  els.callBtn.classList.add("call-btn--active");
  callShowActiveBar("Calling…");
  callStartTimer();
  addSystemMessage(`${ICONS.call} You started a call. Waiting for others to join…`);
}

// Caller: starts a video call
async function callStartVideo() {
  if (!state.mesh || state.mesh.connectedPeerCount() === 0) {
    toast("No one else is in the room.");
    return;
  }
  if (callIsActive()) {
    toast("Already in a call.");
    return;
  }
  try {
    state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.call.localVideoStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    state.call.isVideo = true;
  } catch {
    toast("Camera/microphone access denied.");
    return;
  }
  await callBroadcast({ t: "call-invite", video: true });
  state.call.active = true;
  els.callBtn.classList.add("call-btn--active");
  els.headerVideoCallBtn.classList.add("call-btn--active");
  callShowActiveBar("Video calling…");
  callStartTimer();
  addSystemMessage(`${ICONS.videoCall} You started a video call. Waiting for others to join…`);
}

// Receiver: someone invited us
function callHandleInvite(fromPeerId, peerLabel, isVideo = false) {
  if (callIsActive()) {
    // We're already in a call — auto-join new participants
    callAccept(fromPeerId, isVideo);
    return;
  }
  state.call.incomingCallFrom = fromPeerId;
  state.call.incomingIsVideo = isVideo;
  callShowNotification(peerLabel, isVideo);
}

// Receiver: user clicks Accept (audio or video based on incoming invite)
async function callAccept(fromPeerId, withVideo = false) {
  const targetId = fromPeerId || state.call.incomingCallFrom;
  callHideNotification();
  if (callIsActive() && state.call.peerConnections.has(targetId)) return;

  try {
    if (!state.call.localStream) {
      state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (withVideo && !state.call.localVideoStream) {
      state.call.localVideoStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      state.call.isVideo = true;
    }
  } catch {
    toast("Camera/microphone access denied.");
    return;
  }
  state.call.active = true;
  state.call.incomingCallFrom = null;
  els.callBtn.classList.add("call-btn--active");
  if (withVideo) els.headerVideoCallBtn.classList.add("call-btn--active");
  callShowActiveBar(withVideo ? "Video call active" : "Call active");
  if (!state.call.callStartTime) callStartTimer();

  await callSendTo(targetId, { t: "call-accept" });
  await callCreatePC(targetId, false, withVideo);
  addSystemMessage(withVideo ? `${ICONS.videoCall} You joined the video call.` : `${ICONS.call} You joined the call.`);
}

// Caller: someone accepted
async function callHandleAccept(fromPeerId) {
  if (!callIsActive()) return;
  callShowActiveBar(state.call.isVideo ? "Video call active" : "Call active");
  // Now initiate SDP toward this peer
  await callCreatePC(fromPeerId, true, state.call.isVideo);
}

// Receiver: user clicks Decline
async function callDecline() {
  callHideNotification();
  if (state.call.incomingCallFrom) {
    await callSendTo(state.call.incomingCallFrom, { t: "call-decline" });
  }
  state.call.incomingCallFrom = null;
}

function callHandleDecline(fromPeerId) {
  toast("Call declined.");
  addSystemMessage("📵 Call was declined.");
  if (!state.call.peerConnections.size) {
    callCleanup();
  }
}

// Either side ends the call
async function callEnd() {
  await callBroadcast({ t: "call-end" });
  callCleanup();
  addSystemMessage("📵 Call ended.");
}

function callHandleRemoteEnd(fromPeerId) {
  const pc = state.call.peerConnections.get(fromPeerId);
  if (pc) { pc.close(); state.call.peerConnections.delete(fromPeerId); }
  if (state.call.peerConnections.size === 0) {
    callCleanup();
    addSystemMessage("📵 The call ended.");
  }
}

function callCleanup() {
  callHideNotification();
  callHideActiveBar();
  callStopTimer();
  state.call.active = false;
  state.call.isVideo = false;
  state.call.incomingCallFrom = null;
  state.call.incomingIsVideo = false;
  if (state.call.localStream) {
    state.call.localStream.getTracks().forEach(t => t.stop());
    state.call.localStream = null;
  }
  if (state.call.localVideoStream) {
    state.call.localVideoStream.getTracks().forEach(t => t.stop());
    state.call.localVideoStream = null;
  }
  for (const pc of state.call.peerConnections.values()) pc.close();
  state.call.peerConnections.clear();
  // Clean up remote video elements
  for (const videoEl of state.call.remoteVideoElements.values()) {
    videoEl.srcObject = null;
    videoEl.remove();
  }
  state.call.remoteVideoElements.clear();
  els.callRemoteAudio.srcObject = null;
  els.callBtn.classList.remove("call-btn--active");
  els.headerVideoCallBtn.classList.remove("call-btn--active");
}

// --- Button events ---
els.callBtn.addEventListener("click", () => {
  if (!state.fileTransfer) return; // only in active session
  if (callIsActive()) {
    callEnd();
  } else {
    callStart();
  }
});

els.headerVideoCallBtn.addEventListener("click", () => {
  if (!state.fileTransfer) return;
  if (callIsActive()) {
    callEnd();
  } else {
    callStartVideo();
  }
});

els.callAcceptBtn.addEventListener("click", () => callAccept(null, state.call.incomingIsVideo));
els.callDeclineBtn.addEventListener("click", () => callDecline());
els.callEndBtn.addEventListener("click", () => {
  callEnd();
  addSystemMessage("📵 You ended the call.");
});
