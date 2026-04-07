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
let ffmpeg = null;
let listeners = new Set();

let ffmpegBytesIn = 0;
let ffmpegBytesOut = 0;

// ---- START FFMPEG ----
function startFFmpeg() {
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

    listeners.forEach(res => {
      try { res.write(chunk); } catch (e) {}
    });
  });

  ffmpeg.stderr.on("data", (data) => {
    console.error("ffmpeg:", data.toString());
  });

  ffmpeg.on("close", () => {
    console.log("ffmpeg stopped");
    ffmpeg = null;
  });
}

// ---- STOP FFMPEG ----
function stopFFmpeg() {
  if (ffmpeg) {
    try { ffmpeg.kill("SIGKILL"); } catch (e) {}
    ffmpeg = null;
  }
}

// ---- WEBSOCKET ----
wss.on("connection", (ws) => {
  console.log("🎤 Broadcaster connected");

  // Replace previous broadcaster
  if (broadcaster) {
    broadcaster.close();
  }

  broadcaster = ws;
  ffmpegBytesIn = 0;
  ffmpegBytesOut = 0;

  startFFmpeg();

  ws.on("message", (data, isBinary) => {
    if (!ffmpeg) return;

    if (isBinary) {
      ffmpegBytesIn += data.length;
      ffmpeg.stdin.write(data);
    }
  });

  ws.on("close", () => {
    console.log("🎤 Broadcaster disconnected");
    broadcaster = null;
    stopFFmpeg();
  });
});

// ---- LIVE STREAM ----
app.get("/live.mp3", (req, res) => {
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");

  listeners.add(res);

  console.log("🔊 Listener connected:", listeners.size);

  req.on("close", () => {
    listeners.delete(res);
    console.log("🔊 Listener disconnected:", listeners.size);
  });
});

// ---- HEALTH ----
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    has_broadcaster: !!broadcaster,
    listeners: listeners.size,
    ffmpeg_running: !!ffmpeg,
    ffmpeg_bytes_in: ffmpegBytesIn,
    ffmpeg_bytes_out: ffmpegBytesOut
  });
});

// ---- START SERVER ----
server.listen(PORT, () => {
  console.log("🚀 Relay running on port", PORT);
});
