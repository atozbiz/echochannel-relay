const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ---- STATE ----
let broadcaster = null;
let broadcasterId = 0;
let ffmpeg = null;
let listeners = new Set();

let ffmpegBytesIn = 0;
let ffmpegBytesOut = 0;
let lastChunkAt = 0;
let staleTimer = null;

// ---- HELPERS ----
function now() {
  return Date.now();
}

function safeEndResponse(res) {
  try { res.end(); } catch (e) {}
}

function cleanupListeners() {
  listeners.forEach((res) => {
    safeEndResponse(res);
  });
  listeners.clear();
}

function clearStaleTimer() {
  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
  }
}

function startStaleWatchdog(expectedBroadcasterId) {
  clearStaleTimer();

  staleTimer = setInterval(() => {
    if (!broadcaster) {
      forceStopBroadcast("watchdog:no-broadcaster");
      return;
    }

    if (broadcasterId !== expectedBroadcasterId) {
      clearStaleTimer();
      return;
    }

    if (!lastChunkAt) return;

    var age = now() - lastChunkAt;
    if (age > 1500) {
      console.log("🛑 Watchdog stopping stale broadcast, age:", age);
      forceStopBroadcast("watchdog:stale-audio");
    }
  }, 500);
}

// ---- START FFMPEG ----
function startFFmpeg() {
  stopFFmpeg();

  console.log("🔥 Starting ffmpeg");

  ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-f", "webm",
    "-i", "pipe:0",
    "-vn",
    "-acodec", "libmp3lame",
    "-ac", "2",
    "-ar", "44100",
    "-b:a", "128k",
    "-f", "mp3",
    "pipe:1"
  ]);

  ffmpeg.stdout.on("data", (chunk) => {
    ffmpegBytesOut += chunk.length;

    listeners.forEach((res) => {
      try {
        res.write(chunk);
      } catch (e) {}
    });
  });

  ffmpeg.stderr.on("data", (data) => {
    console.error("ffmpeg:", data.toString());
  });

  ffmpeg.on("close", (code, signal) => {
    console.log("ffmpeg stopped", { code, signal });
    ffmpeg = null;
  });

  ffmpeg.on("error", (err) => {
    console.error("ffmpeg process error:", err && err.message ? err.message : err);
    ffmpeg = null;
  });
}

// ---- STOP FFMPEG ----
function stopFFmpeg() {
  if (!ffmpeg) return;

  try {
    if (ffmpeg.stdin) {
      try { ffmpeg.stdin.end(); } catch (e) {}
      try { ffmpeg.stdin.destroy(); } catch (e) {}
    }
  } catch (e) {}

  try { ffmpeg.kill("SIGKILL"); } catch (e) {}
  ffmpeg = null;
}

// ---- FULL BROADCAST STOP ----
function forceStopBroadcast(reason) {
  console.log("🛑 forceStopBroadcast:", reason);

  clearStaleTimer();

  if (broadcaster) {
    try {
      broadcaster.removeAllListeners("message");
      broadcaster.removeAllListeners("close");
      broadcaster.removeAllListeners("error");
    } catch (e) {}

    try {
      if (
        broadcaster.readyState === WebSocket.OPEN ||
        broadcaster.readyState === WebSocket.CONNECTING
      ) {
        broadcaster.close();
      }
    } catch (e) {}

    try {
      broadcaster.terminate();
    } catch (e) {}
  }

  broadcaster = null;
  broadcasterId = 0;
  lastChunkAt = 0;

  stopFFmpeg();

  ffmpegBytesIn = 0;
  ffmpegBytesOut = 0;

  cleanupListeners();
}

// ---- WEBSOCKET ----
wss.on("connection", (ws) => {
  console.log("🎤 Broadcaster connected");

  // Kill any previous session completely
  if (broadcaster) {
    forceStopBroadcast("new-broadcaster");
  }

  broadcaster = ws;
  broadcasterId = now();
  ffmpegBytesIn = 0;
  ffmpegBytesOut = 0;
  lastChunkAt = 0;

  startFFmpeg();
  startStaleWatchdog(broadcasterId);

  ws.on("message", (data, isBinary) => {
    // Only accept chunks from the active broadcaster
    if (ws !== broadcaster) return;
    if (!ffmpeg || !ffmpeg.stdin) return;
    if (!isBinary) return;

    lastChunkAt = now();
    ffmpegBytesIn += data.length;

    try {
      ffmpeg.stdin.write(data);
    } catch (e) {
      console.error("stdin write error:", e && e.message ? e.message : e);
      forceStopBroadcast("stdin-write-failed");
    }
  });

  ws.on("close", () => {
    if (ws !== broadcaster) return;
    console.log("🎤 Broadcaster disconnected");
    forceStopBroadcast("ws-close");
  });

  ws.on("error", (err) => {
    if (ws !== broadcaster) return;
    console.error("🎤 Broadcaster websocket error:", err && err.message ? err.message : err);
    forceStopBroadcast("ws-error");
  });
});

// ---- LIVE STREAM ----
app.get("/live.mp3", (req, res) => {
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Connection", "keep-alive");

  listeners.add(res);

  console.log("🔊 Listener connected:", listeners.size);

  req.on("close", () => {
    listeners.delete(res);
    console.log("🔊 Listener disconnected:", listeners.size);
  });
});

// ---- MANUAL STOP ----
app.post("/stop", (req, res) => {
  forceStopBroadcast("manual-stop");
  res.json({ ok: true, stopped: true });
});

// ---- HEALTH ----
app.get("/health", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    ok: true,
    has_broadcaster: !!broadcaster,
    listeners: listeners.size,
    ffmpeg_running: !!ffmpeg,
    ffmpeg_bytes_in: ffmpegBytesIn,
    ffmpeg_bytes_out: ffmpegBytesOut,
    last_chunk_age_ms: lastChunkAt ? now() - lastChunkAt : null
  });
});

// ---- START SERVER ----
server.listen(PORT, () => {
  console.log("🚀 Relay running on port", PORT);
});
