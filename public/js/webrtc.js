// webrtc.js — multi-user mesh peer link manager.
// Each PeerMesh manages one RTCPeerConnection per remote peer.
// When a new user joins, we initiate a fresh connection to them.
// All data events bubble up so app.js handles them uniformly.

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

// Additional free TURN servers as fallback (no auth required, limited)
const FALLBACK_TURN_SERVERS = [
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

let cachedIceServers = null;
let iceServersPromise = null;

export async function fetchIceServers() {
  if (cachedIceServers) return cachedIceServers;
  if (iceServersPromise) return iceServersPromise;

  iceServersPromise = (async () => {
    let turnServers = [];
    try {
      const res = await fetch("/turn-credentials");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Metered returns an array of {urls, username, credential} objects
      turnServers = Array.isArray(data) ? data : [];
      console.log("[WebRTC] TURN credentials fetched from Metered:", turnServers.length, "servers");
    } catch (err) {
      console.warn("[WebRTC] Metered TURN fetch failed, trying fallback TURN:", err.message);
      // Try fallback TURN servers
      turnServers = FALLBACK_TURN_SERVERS;
    }

    cachedIceServers = [...STUN_SERVERS, ...turnServers];
    console.log("[WebRTC] ICE servers configured:", cachedIceServers.map(s => s.urls).join(", "));
    return cachedIceServers;
  })();

  return iceServersPromise;
}

// Ensure ICE servers are fetched before any connection is created
let iceServersReady = false;
export async function ensureIceServers() {
  if (iceServersReady) return;
  await fetchIceServers();
  iceServersReady = true;
}

class PeerConnection extends EventTarget {
  constructor(remotePeerId, signaling, isInitiator, iceServers) {
    super();
    this.remotePeerId = remotePeerId;
    this.signaling = signaling;
    this.isInitiator = isInitiator;
    this.iceServers = iceServers;
    this.pc = null;
    this.chatChannel = null;
    this.fileChannel = null;
    this._statsTimer = null;
    this._ready = false;
    this._retryAttempted = false;
    this._iceRestartAttempted = false;
    this._disconnectTimeout = null;
  }

  async start() {
    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({
          type: "signal",
          to: this.remotePeerId,
          payload: { candidate: e.candidate },
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc.iceConnectionState;
      console.log(`[WebRTC] ICE state to ${this.remotePeerId}: ${iceState}`);
      if (iceState === "disconnected" || iceState === "failed") {
        this._scheduleIceRestart();
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log(`[WebRTC] Connection to ${this.remotePeerId} state: ${state}`);
      this.dispatchEvent(new CustomEvent("state", { detail: { peerId: this.remotePeerId, state } }));
      if (state === "connected") {
        this._ready = true;
        this._startStatsLoop();
        this._iceRestartAttempted = false;
        if (this._disconnectTimeout) {
          clearTimeout(this._disconnectTimeout);
          this._disconnectTimeout = null;
        }
      }
      if (["failed", "closed"].includes(state)) {
        this._ready = false;
        this._stopStatsLoop();
        if (state === "failed" && !this._retryAttempted) {
          this._retryAttempted = true;
          console.log(`[WebRTC] Connection to ${this.remotePeerId} failed, retrying with relay-only...`);
          this._retryWithRelay();
        }
      }
      if (state === "disconnected") {
        // Schedule reconnection attempt after 3 seconds
        this._disconnectTimeout = setTimeout(() => {
          this._attemptReconnection();
        }, 3000);
      }
    };

    if (this.isInitiator) {
      this.chatChannel = this.pc.createDataChannel("chat", { ordered: true });
      this.fileChannel = this.pc.createDataChannel("file", { ordered: true });
      this._wireChannel(this.chatChannel, "chat");
      this._wireChannel(this.fileChannel, "file");
      await this._makeOffer();
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === "chat") {
          this.chatChannel = e.channel;
          this._wireChannel(e.channel, "chat");
        } else if (e.channel.label === "file") {
          this.fileChannel = e.channel;
          this._wireChannel(e.channel, "file");
        }
      };
    }
  }

  async _retryWithRelay() {
    try {
      this.close();
      this.pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        iceCandidatePoolSize: 2,
        iceTransportPolicy: "relay",
      });

      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          this.signaling.send({
            type: "signal",
            to: this.remotePeerId,
            payload: { candidate: e.candidate },
          });
        }
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc.connectionState;
        this.dispatchEvent(new CustomEvent("state", { detail: { peerId: this.remotePeerId, state } }));
        if (state === "connected") {
          this._ready = true;
          this._startStatsLoop();
        }
        if (["failed", "disconnected", "closed"].includes(state)) {
          this._ready = false;
          this._stopStatsLoop();
        }
      };

      if (this.isInitiator) {
        this.chatChannel = this.pc.createDataChannel("chat", { ordered: true });
        this.fileChannel = this.pc.createDataChannel("file", { ordered: true });
        this._wireChannel(this.chatChannel, "chat");
        this._wireChannel(this.fileChannel, "file");
        await this._makeOffer();
      } else {
        this.pc.ondatachannel = (e) => {
          if (e.channel.label === "chat") {
            this.chatChannel = e.channel;
            this._wireChannel(e.channel, "chat");
          } else if (e.channel.label === "file") {
            this.fileChannel = e.channel;
            this._wireChannel(e.channel, "file");
          }
        };
      }
    } catch (err) {
      console.error(`[WebRTC] Relay retry failed for ${this.remotePeerId}:`, err);
    }
  }

  _scheduleIceRestart() {
    if (this._iceRestartAttempted) return;
    if (this.pc.connectionState !== "connected" && this.pc.connectionState !== "connecting") return;
    
    this._iceRestartAttempted = true;
    console.log(`[WebRTC] Scheduling ICE restart for ${this.remotePeerId}`);
    
    // Try ICE restart by creating a new offer with ICE restart flag
    setTimeout(async () => {
      try {
        if (this.pc && this.pc.connectionState === "connected") {
          const offer = await this.pc.createOffer({ iceRestart: true });
          await this.pc.setLocalDescription(offer);
          this.signaling.send({
            type: "signal",
            to: this.remotePeerId,
            payload: { sdp: this.pc.localDescription, iceRestart: true },
          });
          console.log(`[WebRTC] ICE restart offer sent for ${this.remotePeerId}`);
        }
      } catch (err) {
        console.error(`[WebRTC] ICE restart failed for ${this.remotePeerId}:`, err);
        this._iceRestartAttempted = false;
      }
    }, 1000);
  }

  async _attemptReconnection() {
    if (this.pc.connectionState === "connected") return;
    if (this._retryAttempted) return;
    
    console.log(`[WebRTC] Attempting reconnection for ${this.remotePeerId}`);
    
    try {
      // Close current PC and create new one
      this.close();
      await this.start();
      
      if (this.isInitiator) {
        await this._makeOffer();
      }
    } catch (err) {
      console.error(`[WebRTC] Reconnection failed for ${this.remotePeerId}:`, err);
    }
  }

  _wireChannel(channel, kind) {
    channel.binaryType = "arraybuffer";
    channel.onopen = () =>
      this.dispatchEvent(new CustomEvent("channel-open", { detail: { peerId: this.remotePeerId, kind } }));
    channel.onclose = () =>
      this.dispatchEvent(new CustomEvent("channel-close", { detail: { peerId: this.remotePeerId, kind } }));
    channel.onmessage = (e) =>
      this.dispatchEvent(new CustomEvent("data", { detail: { peerId: this.remotePeerId, kind, data: e.data } }));
  }

  async _makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({
      type: "signal",
      to: this.remotePeerId,
      payload: { sdp: this.pc.localDescription },
    });
  }

  async handleSignal(payload) {
    const { sdp, candidate } = payload;
    if (sdp) {
      await this.pc.setRemoteDescription(sdp);
      if (sdp.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({
          type: "signal",
          to: this.remotePeerId,
          payload: { sdp: this.pc.localDescription },
        });
      }
    } else if (candidate) {
      try { await this.pc.addIceCandidate(candidate); } catch { /* benign */ }
    }
  }

  send(kind, data) {
    const channel = kind === "chat" ? this.chatChannel : this.fileChannel;
    if (channel && channel.readyState === "open") channel.send(data);
  }

  bufferedAmount(kind) {
    const ch = kind === "chat" ? this.chatChannel : this.fileChannel;
    return ch ? ch.bufferedAmount : 0;
  }

  isReady() { return this._ready; }

  _startStatsLoop() {
    this._stopStatsLoop();
    this._statsTimer = setInterval(async () => {
      if (!this.pc) return;
      const stats = await this.pc.getStats();
      let rttMs = null;
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) {
          rttMs = r.currentRoundTripTime * 1000;
        }
      });
      if (rttMs != null)
        this.dispatchEvent(new CustomEvent("rtt", { detail: { peerId: this.remotePeerId, rttMs } }));
    }, 3000);
  }

  _stopStatsLoop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  close() {
    this._stopStatsLoop();
    this._ready = false;
    if (this.chatChannel) this.chatChannel.close();
    if (this.fileChannel) this.fileChannel.close();
    if (this.pc) this.pc.close();
  }
}

/**
 * PeerMesh — manages connections to ALL peers in a room.
 * Exposes the same event surface as the old PeerLink so app.js stays simple.
 */
export class PeerMesh extends EventTarget {
  constructor(signaling, myPeerId) {
    super();
    this.signaling = signaling;
    this.myPeerId = myPeerId;
    /** @type {Map<string, PeerConnection>} */
    this.connections = new Map();

    signaling.addEventListener("message", (e) => this._onSignalingMsg(e.detail));
  }

  /** Called once after joining: connect to every already-present peer in parallel. */
  async connectToExistingPeers(peerIds) {
    console.log(`[PeerMesh] Connecting to existing peers: ${peerIds.join(", ")}`);
    const iceServers = await fetchIceServers();
    await Promise.all(peerIds.map((pid) => this._createConnection(pid, true, iceServers)));
  }

  /** Server told us a new peer joined — they will initiate toward us. */
  async acceptNewPeer(peerId) {
    console.log(`[PeerMesh] Accepting new peer: ${peerId}`);
    const iceServers = await fetchIceServers();
    await this._createConnection(peerId, false, iceServers);
  }

  async _createConnection(remotePeerId, isInitiator, iceServers) {
    if (this.connections.has(remotePeerId)) return;
    console.log(`[PeerMesh] Creating connection to ${remotePeerId}, isInitiator: ${isInitiator}`);
    const conn = new PeerConnection(remotePeerId, this.signaling, isInitiator, iceServers);

    conn.addEventListener("state", (e) => {
      const { peerId, state } = e.detail;
      this.dispatchEvent(new CustomEvent("peer-state", { detail: { peerId, state } }));
      const connectedCount = [...this.connections.values()].filter(c => c.isReady()).length;
      if (state === "connected") this.dispatchEvent(new CustomEvent("state", { detail: "connected" }));
      if (["failed", "disconnected", "closed"].includes(state) && connectedCount === 0)
        this.dispatchEvent(new CustomEvent("state", { detail: "disconnected" }));
    });

    conn.addEventListener("rtt", (e) => {
      this.dispatchEvent(new CustomEvent("rtt", { detail: e.detail.rttMs }));
    });

    conn.addEventListener("channel-open", (e) => {
      this.dispatchEvent(new CustomEvent("channel-open", { detail: e.detail }));
    });

    conn.addEventListener("data", (e) => {
      this.dispatchEvent(new CustomEvent("data", { detail: e.detail }));
    });

    this.connections.set(remotePeerId, conn);
    await conn.start();
  }

  _onSignalingMsg(msg) {
    if (msg.type === "signal") {
      const conn = this.connections.get(msg.from);
      if (conn) conn.handleSignal(msg.payload);
    }
  }

  removePeer(peerId) {
    const conn = this.connections.get(peerId);
    if (conn) { conn.close(); this.connections.delete(peerId); }
  }

  /** Send to all open connections. */
  broadcast(kind, data) {
    for (const conn of this.connections.values()) conn.send(kind, data);
  }

  /** Send to one specific peer. */
  sendTo(peerId, kind, data) {
    const conn = this.connections.get(peerId);
    if (conn) conn.send(kind, data);
  }

  /** For backward compat with filetransfer (single-target send). */
  send(kind, data) { this.broadcast(kind, data); }

  /** Check if any chat DataChannel is open and ready for signaling. */
  hasOpenChatChannels() {
    for (const conn of this.connections.values()) {
      if (conn.chatChannel && conn.chatChannel.readyState === "open") {
        return true;
      }
    }
    return false;
  }

  bufferedAmount(kind) {
    let max = 0;
    for (const c of this.connections.values()) max = Math.max(max, c.bufferedAmount(kind));
    return max;
  }

  get fileChannel() {
    for (const c of this.connections.values()) if (c.fileChannel) return c.fileChannel;
    return null;
  }

  connectedPeerCount() {
    return [...this.connections.values()].filter(c => c.isReady()).length;
  }

  close() {
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
  }
}

// Warm up ICE servers at module load (before any PeerConnection starts)
fetchIceServers();