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
  filePanel: $("filePanel"),
  filePanelClose: $("filePanelClose"),
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
  videoCallOverlay: $("videoCallOverlay"),
  remoteVideo: $("remoteVideo"),
  localVideo: $("localVideo"),
  localVideoPip: $("localVideoPip"),
  remoteVideoLabel: $("remoteVideoLabel"),
  remoteVideoPlaceholder: $("remoteVideoPlaceholder"),
  videoCallDuration: $("videoCallDuration"),
  qualityBars: $("qualityBars"),
  qualityLabel: $("qualityLabel"),
  videoMuteBtn: $("videoMuteBtn"),
  videoCameraBtn: $("videoCameraBtn"),
  videoEndBtn: $("videoEndBtn"),
  videoFlipBtn: $("videoFlipBtn"),
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

  toolsOverlay: $("toolsOverlay"),
  toolsCloseBtn: $("toolsCloseBtn"),
  convOverlay: $("convOverlay"),
  convModalClose: $("convModalClose"),

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
  // Blob URLs to revoke on cleanup
  fileBlobUrls: [],
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
  console.log("startHosting called");
  const passphrase = document.getElementById("hostPassphraseInput")?.value.trim() || null;
  console.log("passphrase:", passphrase);

  // Prevent double-click
  if (els.hostBtn.disabled) return;
  els.hostBtn.disabled = true;
  const originalBtnText = els.hostBtn.textContent;
  els.hostBtn.textContent = "Creating…";

  try {
    toast("Creating room…");
    showScreen("waiting");
    // Show setup spinner while connecting
    show(els.setupState);
    hide(els.hostLobby);
    hide(els.joinLobby);
    els.waitingLabel.textContent = "Setting up your room…";
    hide(els.roomCodeBlock);
    if (els.qrWrap) hide(els.qrWrap);
    setStatus("connecting", "Connecting…");

    console.log("Creating Signaling instance...");
    state.signaling = new Signaling();
    state.signaling.addEventListener("open", () => {
      console.log("Signaling connected, sending host request");
      state.signaling.send({ type: "host", passphrase });
    });
    state.signaling.addEventListener("message", (e) => {
      console.log("Received signaling message:", e.detail);
      handleSignalingMessage(e.detail);
    });
    state.signaling.addEventListener("error", (err) => {
      console.error("Signaling connection error:", err);
      toast("Connection failed. Check server is running.");
      setStatus("error", "Connection failed");
      resetHostButton();
    });
    state.signaling.addEventListener("close", (e) => {
      console.log("Signaling connection closed:", e);
      if (els.waitingLabel.textContent.includes("Setting up")) {
        toast("Connection lost. Retrying…");
      }
    });
    console.log("Calling signaling.connect()...");
    state.signaling.connect();
  } catch (err) {
    console.error("startHosting error:", err);
    toast("Failed to start: " + err.message);
    resetHostButton();
  }
}

function resetHostButton() {
  els.hostBtn.disabled = false;
  els.hostBtn.textContent = "Start Chat";
}

async function startJoining(code) {
  const passphrase = document.getElementById("joinPassphraseInput")?.value.trim() || null;
  state.roomCode = code;
  toast("Joining room…");
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
  state.signaling.addEventListener("error", () => {
    console.error("Signaling connection error");
    toast("Connection failed. Check server is running.");
    setStatus("error", "Connection failed");
  });
  state.signaling.addEventListener("close", () => {
    console.log("Signaling connection closed");
    if (els.joinLobbySub.textContent.includes("Connecting") || els.joinLobbySub.textContent.includes("Verifying")) {
      toast("Connection lost. Retrying…");
    }
  });
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
      console.log("Received hosted response:", msg);
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
      
      // Wait for QRCode library to be ready, then generate
      const generateQR = () => {
        if (window.QRCode) {
          try {
            els.qrImg.innerHTML = '';
            new QRCode(els.qrImg, {
              text: shareUrl,
              width: 200,
              height: 200,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.M
            });
          } catch (e) {
            console.error("[QR] Library error:", e);
            fallbackToImage();
          }
        } else {
          // Library not ready yet, wait a bit more
          setTimeout(generateQR, 50);
        }
      };
      
      const fallbackToImage = () => {
        els.qrImg.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&qzone=1&data=${encodeURIComponent(shareUrl)}" alt="QR code" style="width:200px;height:200px;">`;
      };
      
      generateQR();
      if (els.qrWrap) show(els.qrWrap);
      // Host creates the mesh but waits for first peer before entering chat
      try {
        state.cryptoKey = await CryptoModule.deriveKeyFromRoomCode(state.roomCode);
        state.mesh = new PeerMesh(state.signaling, state.myPeerId);
        wireMeshEvents();
        toast("Room created! Share the code.");
      } catch (err) {
        console.error("Hosted handler error:", err);
        toast("Error setting up room: " + err.message);
      }
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
  // Clean up observers
  if (typeof visibilityObserver !== "undefined") visibilityObserver.disconnect();
  if (state.resizeObserver) state.resizeObserver.disconnect();
  // Revoke any pending blob URLs
  state.fileBlobUrls?.forEach(url => URL.revokeObjectURL(url));
  state.fileBlobUrls = [];
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

function addSystemMessage(html) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.innerHTML = html;
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
    state.resizeObserver = new ResizeObserver(syncComposerHeight);
    state.resizeObserver.observe(els.composerForm);
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
  videoCall: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
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
    state.fileBlobUrls.push(url);

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
      setTimeout(() => {
        URL.revokeObjectURL(url);
        state.fileBlobUrls = state.fileBlobUrls.filter(u => u !== url);
      }, 60_000);
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

els.attachBtn.addEventListener("click", () => {
  if (els.filePanel) {
    const isHidden = els.filePanel.hidden;
    els.filePanel.hidden = !isHidden;
    if (!isHidden) {
      // Close panel - also close file drop zone
      els.fileDrop.classList.remove('dragover');
    }
  } else {
    els.fileInput.click();
  }
});

els.filePanelClose?.addEventListener("click", () => {
  if (els.filePanel) els.filePanel.hidden = true;
  els.fileDrop.classList.remove('dragover');
});

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

// Voice recording - detect best supported mime type
let voiceMimeType = "audio/webm";
try {
  if (MediaRecorder.isTypeSupported("audio/webm")) voiceMimeType = "audio/webm";
  else if (MediaRecorder.isTypeSupported("audio/mp4")) voiceMimeType = "audio/mp4";
  else if (MediaRecorder.isTypeSupported("audio/aac")) voiceMimeType = "audio/aac";
  else if (MediaRecorder.isTypeSupported("audio/ogg")) voiceMimeType = "audio/ogg";
} catch (e) {
  voiceMimeType = "audio/webm";
}

const voiceState = { mediaRecorder: null, chunks: [], stream: null, recording: false };

async function voiceStart() {
  if (voiceState.recording) return;
  try {
    voiceState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceState.mediaRecorder = new MediaRecorder(voiceState.stream, { mimeType: voiceMimeType });
    voiceState.chunks = [];
    voiceState.mediaRecorder.ondataavailable = (e) => { if (e.data.size) voiceState.chunks.push(e.data); };
    voiceState.mediaRecorder.onstop = async () => {
      const ext = voiceMimeType.split("/")[1] || "webm";
      const blob = new Blob(voiceState.chunks, { type: voiceMimeType });
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: voiceMimeType });
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
function attachHomeUI() {
  console.log("[attachHomeUI] hostBtn:", els.hostBtn);
  if (!els.hostBtn) {
    console.error("[attachHomeUI] hostBtn not found in DOM, waiting for DOMContentLoaded");
    document.addEventListener("DOMContentLoaded", attachHomeUI, { once: true });
    return;
  }
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

// QR code scanning from photo
els.qrCamBtn?.addEventListener("click", () => {
  els.qrPhotoInput?.click();
});

els.qrPhotoInput?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("qrCamStatus");
  statusEl.textContent = "Scanning…";
  statusEl.hidden = false;
  try {
    const canvas = document.getElementById("qrCanvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    
    // Try to decode QR code from canvas
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let code = null;
    
    // Try jsQR if available (we'll load it dynamically)
    if (window.jsQR) {
      code = jsQR(imageData.data, canvas.width, canvas.height);
    } else {
      // Load jsQR dynamically
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
      document.head.appendChild(script);
      await new Promise(r => script.onload = r);
      code = window.jsQR(imageData.data, canvas.width, canvas.height);
    }
    
    if (code && code.data) {
      const extractedCode = normalizeCode(code.data);
      if (/^[A-Z0-9]{4}$/.test(extractedCode)) {
        els.joinCodeInput.value = extractedCode;
        statusEl.textContent = "QR code detected!";
        setTimeout(() => startJoining(extractedCode), 500);
      } else {
        statusEl.textContent = "Invalid QR code format";
      }
    } else {
      statusEl.textContent = "No QR code found in image";
    }
  } catch (err) {
    console.error("QR scan error:", err);
    statusEl.textContent = "Failed to scan QR code";
  }
  // Clear input for next scan
  e.target.value = "";
  setTimeout(() => statusEl.hidden = true, 3000);
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

// ---------------------------------------------------------------- tools panel
els.toolsBtn.addEventListener("click", () => show(els.toolsOverlay));
els.toolsCloseBtn.addEventListener("click", () => hide(els.toolsOverlay));
els.toolsOverlay.addEventListener("click", (e) => {
  if (e.target === els.toolsOverlay) hide(els.toolsOverlay);
});

// ---------------------------------------------------------------- converter modal
els.convModalClose.addEventListener("click", () => hide(els.convOverlay));
els.convOverlay.addEventListener("click", (e) => {
  if (e.target === els.convOverlay) hide(els.convOverlay);
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
  
  // Show loading state
  const vf = document.getElementById("cameraViewfinder");
  if (!vf.querySelector(".camera-loading")) {
    const loading = document.createElement("div");
    loading.className = "camera-loading";
    loading.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000;z-index:10;color:var(--muted);";
    loading.innerHTML = '<svg class="spin" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"/></svg>';
    vf.appendChild(loading);
  }
  
  cameraStart().finally(() => {
    const loading = vf.querySelector(".camera-loading");
    if (loading) loading.remove();
  });
}

function cameraHide() {
  cameraStop();
  els.cameraOverlay.setAttribute("hidden", "");
  if (els.cameraPreview.src && els.cameraPreview.src.startsWith("blob:")) {
    URL.revokeObjectURL(els.cameraPreview.src);
  }
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
    // Restore viewfinder if error replaced it
    const vf = document.getElementById("cameraViewfinder");
    if (!vf.contains(els.cameraVideo)) {
      vf.innerHTML = "";
      vf.appendChild(els.cameraVideo);
      vf.appendChild(els.cameraCanvas);
      vf.appendChild(els.cameraPreview);
      vf.appendChild(els.cameraFlash);
    }
  } catch (err) {
    console.error("Camera start failed:", err);
    els.cameraVideo.setAttribute("hidden", "");
    const vf = document.getElementById("cameraViewfinder");
    vf.innerHTML = `
      <div class="camera-error">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Camera access denied or unavailable.<br>
        <button class="btn primary small" onclick="openFilePicker()" style="margin-top: 12px;">Choose Image Instead</button>
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
      state.fileBlobUrls.push(url);
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
  
  // Try camera first, fallback to file picker on non-mobile or if camera fails
  const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  if (isMobile) {
    cameraShow();
  } else {
    // On desktop, show both options: camera or file picker
    if (window.confirm("Open camera or choose from files?")) {
      cameraShow();
    } else {
      openFilePicker();
    }
  }
});

// File picker fallback for desktop (global for inline onclick)
window.openFilePicker = function openFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file && state.fileTransfer) {
      state.fileTransfer.enqueue([file]);
    }
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

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

import { fetchIceServers } from "./webrtc.js";

let callIceServers = null;
async function getCallIceServers() {
  if (callIceServers) return callIceServers;
  callIceServers = await fetchIceServers();
  return callIceServers;
}

// Video quality profiles - adaptive based on connection
const VIDEO_QUALITY = {
  high: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, maxBitrate: 2500000 },
  medium: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 }, maxBitrate: 1000000 },
  low: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 }, maxBitrate: 500000 },
};

let currentVideoQuality = "high";
let bandwidthCheckInterval = null;

// Video call state
Object.assign(state.call, {
  isVideo: false,
  localVideoStream: null,
  remoteVideoElements: new Map(),
});

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
  if (state.call.isVideo) {
    // Video call - show full-screen overlay
    els.videoCallOverlay?.removeAttribute("hidden");
    els.remoteVideoLabel.textContent = label || "Video call";
    els.remoteVideoPlaceholder?.setAttribute("hidden", "");
    // Ensure local video preview shows
    if (els.localVideo && state.call.localVideoStream) {
      els.localVideo.srcObject = state.call.localVideoStream;
    }
    // Reset quality indicator
    updateConnectionQuality("good");
    // Force video elements to play
    if (els.localVideo) els.localVideo.play().catch(() => {});
    if (els.remoteVideo) els.remoteVideo.play().catch(() => {});
  } else {
    // Audio call - show top bar
    els.callActiveLabel.textContent = label || "Call active";
    els.callActiveBar.removeAttribute("hidden");
    document.body.classList.add("call-bar-active");
  }
}
function callHideActiveBar() {
  els.callActiveBar.setAttribute("hidden", "");
  document.body.classList.remove("call-bar-active");
  els.videoCallOverlay?.setAttribute("hidden", "");
  els.remoteVideoPlaceholder?.removeAttribute("hidden");
  stopBandwidthMonitoring();
}
function callStartTimer() {
  state.call.callStartTime = Date.now();
  if (state.call.callTimerHandle) clearInterval(state.call.callTimerHandle);
  state.call.callTimerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - state.call.callStartTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toString().padStart(2, "0");
    els.callActiveTimer.textContent = `${m}:${s}`;
    if (els.videoCallDuration) {
      els.videoCallDuration.textContent = `${m}:${s}`;
    }
  }, 1000);
}

function updateConnectionQuality(quality) {
  if (!els.qualityBars) return;
  els.qualityBars.className = `quality-bars quality-${quality}`;
  if (els.qualityLabel) {
    const labels = { good: "Good", fair: "Fair", poor: "Poor" };
    els.qualityLabel.textContent = labels[quality] || "Good";
  }
}
function callStopTimer() {
  if (state.call.callTimerHandle) clearInterval(state.call.callTimerHandle);
  state.call.callTimerHandle = null;
  els.callActiveTimer.textContent = "0:00";
  stopBandwidthMonitoring();
}

function startBandwidthMonitoring() {
  if (bandwidthCheckInterval) return;
  bandwidthCheckInterval = setInterval(async () => {
    if (!state.call.isVideo || !state.call.active) {
      stopBandwidthMonitoring();
      return;
    }
    for (const [peerId, pc] of state.call.peerConnections.entries()) {
      try {
        const stats = await pc.getStats();
        let bytesReceived = 0, packetsLost = 0, packetsReceived = 0;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            bytesReceived += report.bytesReceived || 0;
            packetsLost += report.packetsLost || 0;
            packetsReceived += report.packetsReceived || 0;
          }
        });
        if (packetsReceived > 0) {
          const lossRate = packetsLost / (packetsReceived + packetsLost);
          if (lossRate > 0.1 && currentVideoQuality !== "low") {
            currentVideoQuality = currentVideoQuality === "high" ? "medium" : "low";
            await renegotiateVideoQuality();
          } else if (lossRate < 0.01 && currentVideoQuality !== "high") {
            currentVideoQuality = currentVideoQuality === "low" ? "medium" : "high";
            await renegotiateVideoQuality();
          }
        }
      } catch (e) {
        // Stats not available yet
      }
    }
  }, 5000);
}

function stopBandwidthMonitoring() {
  if (bandwidthCheckInterval) {
    clearInterval(bandwidthCheckInterval);
    bandwidthCheckInterval = null;
  }
}

async function renegotiateVideoQuality() {
  const constraints = VIDEO_QUALITY[currentVideoQuality];
  if (!state.call.localVideoStream) return;
  const sender = [...state.call.peerConnections.values()][0]?.getSenders?.().find(s => s.track?.kind === "video");
  if (sender && sender.track) {
    try {
      await sender.track.applyConstraints(constraints);
    } catch (e) {
      console.warn("Failed to apply video constraints:", e);
    }
  }
}

// Broadcast a call-typed chat payload to all peers
async function callBroadcast(obj) {
  if (!state.mesh || !state.cryptoKey) {
    console.error("[callBroadcast] No mesh or cryptoKey available");
    throw new Error("Call infrastructure not ready");
  }
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.broadcast("chat", encrypted.buffer.slice(0));
}
async function callSendTo(peerId, obj) {
  if (!state.mesh || !state.cryptoKey) {
    console.error("[callSendTo] No mesh or cryptoKey available");
    throw new Error("Call infrastructure not ready");
  }
  const encrypted = await CryptoModule.encryptJSON(state.cryptoKey, obj);
  state.mesh.sendTo(peerId, "chat", encrypted.buffer.slice(0));
}

// --- WebRTC peer connection (audio + optional video) ---
async function callCreatePC(remotePeerId, isInitiator, withVideo = false) {
  console.log(`[callCreatePC] Creating PC for ${remotePeerId}, isInitiator: ${isInitiator}, withVideo: ${withVideo}`);
  const iceServers = await getCallIceServers();
  console.log(`[callCreatePC] Using ICE servers:`, iceServers.map(s => s.urls));
  const pc = new RTCPeerConnection({ iceServers });

  pc.oniceconnectionstatechange = () => {
    console.log(`[callCreatePC] ICE state for ${remotePeerId}: ${pc.iceConnectionState}`);
  };
  pc.onconnectionstatechange = () => {
    console.log(`[callCreatePC] Connection state for ${remotePeerId}: ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      console.log(`[callCreatePC] Call connected with ${remotePeerId}`);
    } else if (pc.connectionState === "failed") {
      console.error(`[callCreatePC] Call failed with ${remotePeerId}`);
      toast("Call connection failed. Check network/TURN.");
    }
  };

  // Add local audio tracks
  if (state.call.localStream) {
    state.call.localStream.getTracks().forEach(t => pc.addTrack(t, state.call.localStream));
    console.log(`[callCreatePC] Added audio track`);
  }
  // Add local video tracks
  if (withVideo && state.call.localVideoStream) {
    state.call.localVideoStream.getTracks().forEach(t => pc.addTrack(t, state.call.localVideoStream));
    console.log(`[callCreatePC] Added video track`);
  }

  // Handle remote tracks
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    const hasVideo = stream.getVideoTracks().length > 0;
    console.log(`[callCreatePC] Received remote track: audio=${stream.getAudioTracks().length > 0}, video=${hasVideo}`);
    if (hasVideo) {
      // Use the dedicated remote video element in the video call overlay
      if (els.remoteVideo) {
        els.remoteVideo.srcObject = stream;
        els.remoteVideoLabel.textContent = "Connected";
        els.remoteVideoPlaceholder?.setAttribute("hidden", "");
      }
    } else {
      els.callRemoteAudio.srcObject = stream;
    }
  };

  // ICE → send via encrypted chat channel
  pc.onicecandidate = async (e) => {
    if (e.candidate) {
      console.log(`[callCreatePC] Sending ICE candidate to ${remotePeerId}`);
      await callSendTo(remotePeerId, { t: "call-signal", payload: { candidate: e.candidate } });
    }
  };

  state.call.peerConnections.set(remotePeerId, pc);

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await callSendTo(remotePeerId, { t: "call-signal", payload: { sdp: pc.localDescription, video: withVideo } });
    console.log(`[callCreatePC] Sent offer to ${remotePeerId}`);
  }
  return pc;
}

async function callHandleSignal(fromPeerId, payload) {
  console.log(`[callHandleSignal] Received signal from ${fromPeerId}:`, payload.sdp ? `sdp:${payload.sdp.type}` : "candidate");
  let pc = state.call.peerConnections.get(fromPeerId);
  const withVideo = payload.video === true;
  if (!pc) {
    // We just accepted the call; create PC as non-initiator
    console.log(`[callHandleSignal] Creating new PC for ${fromPeerId}`);
    pc = await callCreatePC(fromPeerId, false, withVideo);
  }
  const { sdp, candidate } = payload;
  if (sdp) {
    try {
      await pc.setRemoteDescription(sdp);
      console.log(`[callHandleSignal] Set remote description: ${sdp.type}`);
      if (sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await callSendTo(fromPeerId, { t: "call-signal", payload: { sdp: pc.localDescription } });
        console.log(`[callHandleSignal] Sent answer to ${fromPeerId}`);
      }
    } catch (err) {
      console.error(`[callHandleSignal] SDP error:`, err);
      toast("Call signaling error: " + err.message);
    }
  } else if (candidate) {
    try { 
      await pc.addIceCandidate(candidate); 
      console.log(`[callHandleSignal] Added ICE candidate`);
    } catch (err) {
      console.warn(`[callHandleSignal] ICE candidate error (benign):`, err.message);
    }
  }
}

// --- Call flow ---

// Get connected peers with labels for recipient selection
function getConnectedPeers() {
  if (!state.mesh) return [];
  const peers = [];
  for (const [peerId, conn] of state.mesh.connections.entries()) {
    if (conn.isReady && conn.isReady()) {
      peers.push({
        peerId,
        label: state.peerNames.get(peerId) || peerId.slice(0, 4).toUpperCase()
      });
    }
  }
  return peers;
}

// Show recipient picker for call initiation
function showCallRecipientPicker(isVideo = false) {
  const peers = getConnectedPeers();
  if (peers.length === 0) {
    toast("No one else is in the room.");
    return;
  }
  if (peers.length === 1) {
    // Only one peer, call directly
    callInitiateToPeer(peers[0].peerId, peers[0].label, isVideo);
    return;
  }

  // Multiple peers - show picker
  const picker = document.createElement("div");
  picker.className = "call-recipient-picker";
  picker.innerHTML = `
    <div class="call-picker-backdrop"></div>
    <div class="call-picker-card">
      <div class="call-picker-header">
        <span>${isVideo ? "Video call" : "Voice call"}</span>
        <button class="call-picker-close" aria-label="Close">&times;</button>
      </div>
      <div class="call-picker-list">
        ${peers.map(p => `
          <button class="call-picker-item" data-peer-id="${p.peerId}" data-peer-label="${p.label}">
            <span class="call-picker-avatar">${p.label.charAt(0)}</span>
            <span class="call-picker-name">${p.label}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;

  const closePicker = () => {
    picker.remove();
    document.removeEventListener("keydown", onKeydown);
  };

  const onKeydown = (e) => {
    if (e.key === "Escape") closePicker();
  };

  picker.querySelector(".call-picker-backdrop").addEventListener("click", closePicker);
  picker.querySelector(".call-picker-close").addEventListener("click", closePicker);
  picker.querySelectorAll(".call-picker-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const peerId = btn.dataset.peerId;
      const label = btn.dataset.peerLabel;
      closePicker();
      callInitiateToPeer(peerId, label, isVideo);
    });
  });

  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(picker);
}

// Initiate call to a specific peer
async function callInitiateToPeer(peerId, peerLabel, isVideo = false) {
  if (callIsActive()) {
    toast("Already in a call.");
    return;
  }
  try {
    state.call.localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: true, 
      video: isVideo ? VIDEO_QUALITY.high : false 
    });
    state.call.isVideo = isVideo;
    if (isVideo) {
      state.call.localVideoStream = state.call.localStream;
      currentVideoQuality = "high";
      startBandwidthMonitoring();
      const videoTrack = state.call.localVideoStream.getVideoTracks()[0];
      if (els.localVideoPip && videoTrack?.getSettings().facingMode === "user") {
        els.localVideoPip.classList.add("mirror");
      }
    }
  } catch {
    toast(isVideo ? "Camera/microphone access denied." : "Microphone access denied.");
    return;
  }

  await callSendTo(peerId, { t: "call-invite", video: isVideo });
  state.call.active = true;
  els.callBtn.classList.add("call-btn--active");
  if (isVideo) els.headerVideoCallBtn.classList.add("call-btn--active");
  callShowActiveBar(isVideo ? "Video calling…" : "Calling…");
  callStartTimer();
  addSystemMessage(`${isVideo ? ICONS.videoCall : ICONS.call} You started a ${isVideo ? "video " : ""}call to ${peerLabel}. Waiting for answer…`);
}

// Caller: starts an audio call
async function callStart() {
  showCallRecipientPicker(false);
}

// Caller: starts a video call
async function callStartVideo() {
  showCallRecipientPicker(true);
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
    state.call.localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: VIDEO_QUALITY.high 
    });
    state.call.localVideoStream = state.call.localStream;
    state.call.isVideo = true;
    currentVideoQuality = "high";
    startBandwidthMonitoring();
    // Set mirror for local preview (front camera = mirrored)
    const videoTrack = state.call.localVideoStream.getVideoTracks()[0];
    if (els.localVideoPip && videoTrack?.getSettings().facingMode === "user") {
      els.localVideoPip.classList.add("mirror");
    }
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

  // Ensure chat channel is open for signaling
  if (state.mesh && !state.mesh.hasOpenChatChannels()) {
    toast("Connection not ready. Please wait a moment.");
    return;
  }

  try {
    if (withVideo) {
      if (!state.call.localStream || !state.call.localVideoStream) {
        state.call.localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: VIDEO_QUALITY.high
        });
        state.call.localVideoStream = state.call.localStream;
        state.call.isVideo = true;
        currentVideoQuality = "high";
        startBandwidthMonitoring();
        // Set mirror for local preview (front camera = mirrored)
        const videoTrack = state.call.localVideoStream.getVideoTracks()[0];
        if (els.localVideoPip && videoTrack?.getSettings().facingMode === "user") {
          els.localVideoPip.classList.add("mirror");
        }
      }
    } else if (!state.call.localStream) {
      state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
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
els.callBtn.addEventListener("click", async () => {
  console.log("[callBtn] clicked", { mesh: !!state.mesh, peers: state.mesh?.connectedPeerCount(), active: callIsActive(), chatOpen: state.mesh?.hasOpenChatChannels?.() });
  if (!state.mesh || state.mesh.connectedPeerCount() === 0) {
    toast("No one connected yet. Wait for peer to join.");
    return;
  }
  if (!state.mesh.hasOpenChatChannels()) {
    toast("Connection not ready. Please wait a moment.");
    return;
  }
  if (callIsActive()) {
    callEnd();
  } else {
    try {
      await callStart();
    } catch (err) {
      console.error("[callBtn] callStart failed:", err);
      toast("Failed to start call: " + err.message);
    }
  }
});

els.headerVideoCallBtn.addEventListener("click", async () => {
  console.log("[headerVideoCallBtn] clicked", { mesh: !!state.mesh, peers: state.mesh?.connectedPeerCount(), active: callIsActive(), chatOpen: state.mesh?.hasOpenChatChannels?.() });
  if (!state.mesh || state.mesh.connectedPeerCount() === 0) {
    toast("No one connected yet. Wait for peer to join.");
    return;
  }
  if (!state.mesh.hasOpenChatChannels()) {
    toast("Connection not ready. Please wait a moment.");
    return;
  }
  if (callIsActive()) {
    callEnd();
  } else {
    try {
      await callStartVideo();
    } catch (err) {
      console.error("[headerVideoCallBtn] callStartVideo failed:", err);
      toast("Failed to start video call: " + err.message);
    }
  }
});

els.callAcceptBtn.addEventListener("click", () => callAccept(null, state.call.incomingIsVideo));
els.callDeclineBtn.addEventListener("click", () => callDecline());
els.callEndBtn.addEventListener("click", () => {
  callEnd();
  addSystemMessage("📵 You ended the call.");
});

// Video call controls
els.videoMuteBtn?.addEventListener("click", () => {
  if (state.call.localStream) {
    const audioTrack = state.call.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      els.videoMuteBtn.classList.toggle("muted", !audioTrack.enabled);
    }
  }
});

els.videoCameraBtn?.addEventListener("click", () => {
  if (state.call.localVideoStream) {
    const videoTrack = state.call.localVideoStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      els.videoCameraBtn.classList.toggle("camera-off", !videoTrack.enabled);
      // Update local preview visibility
      if (els.localVideo) els.localVideo.style.opacity = videoTrack.enabled ? "1" : "0.3";
    }
  }
});

els.videoFlipBtn?.addEventListener("click", async () => {
  if (!state.call.localVideoStream) return;
  const oldTrack = state.call.localVideoStream.getVideoTracks()[0];
  const wasUserFacing = oldTrack.getSettings().facingMode === "user";
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: wasUserFacing ? "environment" : "user" }
    });
    const newTrack = newStream.getVideoTracks()[0];
    state.call.localVideoStream.removeTrack(oldTrack);
    state.call.localVideoStream.addTrack(newTrack);
    oldTrack.stop();
    // Update peer connections
    for (const pc of state.call.peerConnections.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
    }
    // Update local preview
    if (els.localVideo) els.localVideo.srcObject = state.call.localVideoStream;
    // Toggle mirror class for local preview (only mirror for front-facing/user camera)
    if (els.localVideoPip) {
      els.localVideoPip.classList.toggle("mirror", !wasUserFacing);
    }
  } catch (err) {
    console.error("Camera flip failed:", err);
  }
});

els.videoEndBtn?.addEventListener("click", () => {
  callEnd();
  addSystemMessage("📵 You ended the video call.");
});

attachHomeUI();
