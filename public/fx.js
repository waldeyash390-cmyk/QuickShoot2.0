// fx.js — premium 3D visuals that cost almost zero bandwidth.
//
// Replaces the old 4 MB background video with a tiny WebGL scene (a rotating
// 3D "peer network" with data packets travelling between nodes). It is drawn
// on the GPU, so it adds ~5 KB of code instead of megabytes of download.
//
// Automatically turns itself OFF (plain gradient instead) when:
//   - the user enabled Data Saver / Save-Data
//   - the connection is 2G / slow-2G
//   - the user prefers reduced motion
//   - WebGL is missing or the GPU context is lost
// and runs a lighter version on low-memory / low-core phones.

const root = document.documentElement;

/* ------------------------------------------------------------ capability */
const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
const slowNet = !!conn.saveData || /(^|-)2g$/.test(conn.effectiveType || "");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
               (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);

// "lite" turns off expensive CSS (blur, endless animations) for weak devices.
if (slowNet || reduced || lowEnd) root.classList.add("lite");

/* ------------------------------------------------------------- 3D scene */
const VERT = `
attribute vec3 p;
uniform vec2 uRot;      // x = yaw, y = pitch
uniform vec2 uScale;    // aspect-corrected scale
uniform float uTime, uSize, uDpr, uPulse;
varying float vDepth;
void main(){
  float cy = cos(uRot.x), sy = sin(uRot.x), cx = cos(uRot.y), sx = sin(uRot.y);
  vec3 q = vec3(p.x*cy + p.z*sy, p.y, -p.x*sy + p.z*cy);   // yaw
  q = vec3(q.x, q.y*cx - q.z*sx, q.y*sx + q.z*cx);          // pitch
  vDepth = q.z*0.5 + 0.5;
  gl_Position = vec4(q.xy*uScale, q.z*0.2, 2.9 - q.z);
  float pulse = uPulse > 0.5 ? 0.6 + 0.4*sin(uTime*2.0 + p.x*7.0 + p.y*5.0) : 1.0;
  gl_PointSize = uDpr * uSize * (0.55 + vDepth) * pulse;
}`;

const FRAG = `
precision mediump float;
uniform vec3 uColor;
uniform float uPoint, uAlpha;
varying float vDepth;
void main(){
  float a = uAlpha * (0.15 + 0.85*vDepth);
  if (uPoint > 0.5) {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    a *= smoothstep(0.5, 0.0, d);
  }
  gl_FragColor = vec4(uColor, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function buildNetwork(n) {
  // Fibonacci sphere = evenly spread nodes, with slight radius jitter for depth.
  const pts = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = ga * i;
    const k = 0.9 + ((i * 2654435761) % 1000) / 1000 * 0.2; // deterministic jitter
    pts.push([Math.cos(t) * r * k, y * k, Math.sin(t) * r * k]);
  }
  const edges = [];
  const maxD = 1.5 * Math.sqrt((4 * Math.PI) / n); // ~4-6 neighbours per node
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = pts[i][2] - pts[j][2];
      if (dx * dx + dy * dy + dz * dz < maxD * maxD) edges.push([i, j]);
    }
  }
  return { pts, edges };
}

function startScene(canvas) {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: true, powerPreference: "low-power" });
  if (!gl) return null;

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
  } catch (e) { return null; }
  gl.useProgram(prog);

  const N = lowEnd ? 56 : 110;
  const { pts, edges } = buildNetwork(N);

  const ptData = new Float32Array(pts.flat());
  const lnData = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => {
    lnData.set(pts[a], i * 6);
    lnData.set(pts[b], i * 6 + 3);
  });

  const PACKETS = lowEnd ? 4 : 8;
  const packets = Array.from({ length: PACKETS }, (_, i) => ({
    e: (i * 17) % edges.length, t: i / PACKETS, s: 0.35 + (i % 3) * 0.12
  }));
  const pkData = new Float32Array(PACKETS * 3);

  const mk = (data, usage) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return b;
  };
  const bufPts = mk(ptData, gl.STATIC_DRAW);
  const bufLines = mk(lnData, gl.STATIC_DRAW);
  const bufPk = mk(pkData, gl.DYNAMIC_DRAW);

  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u = {
    rot: U("uRot"), scale: U("uScale"), time: U("uTime"), size: U("uSize"),
    dpr: U("uDpr"), pulse: U("uPulse"), color: U("uColor"), point: U("uPoint"), alpha: U("uAlpha")
  };

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive = glow
  gl.clearColor(0, 0, 0, 0);

  const DPR = Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : 1.5);
  let w = 1, h = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width * DPR));
    h = Math.max(1, Math.round(r.height * DPR));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // pointer parallax (mouse / touch drag) — smooth follow
  let tx = 0, ty = 0, cxr = 0, cyr = 0;
  const onMove = (e) => {
    const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
    tx = x * 1.1; ty = y * 0.7;
  };
  addEventListener("pointermove", onMove, { passive: true });

  let running = false, raf = 0, last = 0, yaw = 0, started = performance.now();
  const frameMs = lowEnd ? 1000 / 30 : 1000 / 60;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < frameMs - 1) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const t = (now - started) / 1000;

    yaw += dt * 0.12;
    cxr += (tx - cxr) * 0.05;
    cyr += (ty - cyr) * 0.05;

    gl.clear(gl.COLOR_BUFFER_BIT);
    const aspect = w / h;
    // fit the sphere to the smaller screen side (works for phone + desktop)
    const sc = 1.8;
    gl.uniform2f(u.scale, aspect >= 1 ? sc / aspect : sc, aspect >= 1 ? sc : sc * aspect);
    gl.uniform2f(u.rot, yaw + cxr, 0.35 + cyr);
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.dpr, DPR);
    gl.uniform3f(u.color, 0.37, 0.9, 0.77); // accent #5ee6c5

    // 1) edges
    gl.bindBuffer(gl.ARRAY_BUFFER, bufLines);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.uniform1f(u.point, 0); gl.uniform1f(u.alpha, 0.2); gl.uniform1f(u.pulse, 0); gl.uniform1f(u.size, 1);
    gl.drawArrays(gl.LINES, 0, edges.length * 2);

    // 2) nodes
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPts);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.uniform1f(u.point, 1); gl.uniform1f(u.alpha, 0.95); gl.uniform1f(u.pulse, 1); gl.uniform1f(u.size, 9);
    gl.drawArrays(gl.POINTS, 0, N);

    // 3) data packets sliding along edges (the "peer-to-peer transfer")
    for (let i = 0; i < PACKETS; i++) {
      const k = packets[i];
      k.t += dt * k.s;
      if (k.t >= 1) { k.t = 0; k.e = (k.e * 7 + 13 + i) % edges.length; }
      const [a, b] = edges[k.e];
      const A = pts[a], B = pts[b];
      pkData[i * 3] = A[0] + (B[0] - A[0]) * k.t;
      pkData[i * 3 + 1] = A[1] + (B[1] - A[1]) * k.t;
      pkData[i * 3 + 2] = A[2] + (B[2] - A[2]) * k.t;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPk);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pkData);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.uniform3f(u.color, 1, 1, 1);
    gl.uniform1f(u.pulse, 0); gl.uniform1f(u.size, 14); gl.uniform1f(u.alpha, 1);
    gl.drawArrays(gl.POINTS, 0, PACKETS);
  }

  function start() { if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // Only draw while the home screen is actually visible & the tab is active.
  let inView = true;
  const io = new IntersectionObserver((en) => { inView = en[0].isIntersecting; sync(); });
  io.observe(canvas);
  const sync = () => (inView && !document.hidden ? start() : stop());
  document.addEventListener("visibilitychange", sync);

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); stop(); canvas.classList.add("off");
  });

  sync();
  return { stop, destroy() { stop(); ro.disconnect(); io.disconnect(); removeEventListener("pointermove", onMove); } };
}

/* --------------------------------------------------------- 3D card tilt */
function initTilt() {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return; // skip touch screens
  document.querySelectorAll(".choice-card").forEach((card) => {
    let raf = 0;
    card.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        card.style.setProperty("--ry", ((px - 0.5) * 12).toFixed(2) + "deg");
        card.style.setProperty("--rx", ((0.5 - py) * 10).toFixed(2) + "deg");
        card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
        card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
      });
    });
    card.addEventListener("pointerleave", () => {
      cancelAnimationFrame(raf);
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
    });
  });
}

/* ------------------------------------------------------------------ init */
export function initFx() {
  const canvas = document.getElementById("bgCanvas");
  if (canvas && !slowNet && !reduced) {
    try {
      if (!startScene(canvas)) canvas.classList.add("off");
    } catch (e) { canvas.classList.add("off"); }
  } else if (canvas) {
    canvas.classList.add("off");
  }
  if (!root.classList.contains("lite")) initTilt();
}
