const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// Optional: comma-separated allowed origins in Railway variables
// Example:
// ALLOWED_ORIGINS=https://your-base44-app.com,https://preview.base44.app
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(function (s) { return s.trim(); })
  .filter(Boolean);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024)
  }
});

const liveClients = new Set();

let recentMp3Chunks = [];
let recentMp3Bytes = 0;
const MAX_RECENT_MP3_BYTES = Number(process.env.MAX_RECENT_MP3_BYTES || 3 * 1024 * 1024);

let ffmpeg = null;
let ffmpegStarted = false;
let ffmpegInputMime = "";
let ffmpegLastStartAt = 0;
let ffmpegBytesIn = 0;
let ffmpegBytesOut = 0;

let lastMimeType = "audio/mpeg";
let lastChunkAt = null;
let ingestCount = 0;

function log() {
  console.log.apply(console, arguments);
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function addRecentMp3Chunk(buffer) {
  if (!buffer || !buffer.length) return;

  recentMp3Chunks.push(buffer);
  recentMp3Bytes += buffer.length;

  while (recentMp3Bytes > MAX_RECENT_MP3_BYTES && recentMp3Chunks.length > 0) {
    const removed = recentMp3Chunks.shift();
    recentMp3Bytes -= removed.length;
  }
}

function broadcastMp3Chunk(buffer) {
  if (!buffer || !buffer.length) return;

  addRecentMp3Chunk(buffer);

  liveClients.forEach(function (res) {
    try {
      res.write(buffer);
    } catch (err) {
      try { res.end(); } catch (e) {}
      liveClients.delete(res);
    }
  });
}

function stopFfmpeg() {
  if (!ffmpeg) return;

  log("[ffmpeg] stopping");

  try {
    ffmpeg.stdin.end();
  } catch (e) {}

  try {
    ffmpeg.kill("SIGKILL");
  } catch (e) {}

  ffmpeg = null;
  ffmpegStarted = false;
}

function getInputFormatFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();

  if (mime.indexOf("webm") !== -1) return "webm";
  if (mime.indexOf("ogg") !== -1) return "ogg";
  if (mime.indexOf("mpeg") !== -1 || mime.indexOf("mp3") !== -1) return "mp3";

  return "webm";
}

function startFfmpeg(mimeType) {
  const inputFormat = getInputFormatFromMime(mimeType);

  if (ffmpeg && ffmpegStarted && ffmpegInputMime === inputFormat) {
    return;
  }

  if (ffmpeg) {
    stopFfmpeg();
  }

  log("[ffmpeg] starting, input format =", inputFormat);

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-f", inputFormat,
    "-i", "pipe:0",
    "-vn",
    "-acodec", "libmp3lame",
    "-ac", "2",
    "-ar", "44100",
    "-b:a", "128k",
    "-f", "mp3",
    "pipe:1"
  ];

  ffmpeg = spawn("ffmpeg", args, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  ffmpegStarted = true;
  ffmpegInputMime = inputFormat;
  ffmpegLastStartAt = Date.now();

  ffmpeg.stdout.on("data", function (chunk) {
    ffmpegBytesOut += chunk.length;
    broadcastMp3Chunk(chunk);
  });

  ffmpeg.stderr.on("data", function (chunk) {
    const msg = String(chunk || "").trim();
    if (msg) {
      console.error("[ffmpeg stderr]", msg);
    }
  });

  ffmpeg.on("error", function (err) {
    console.error("[ffmpeg error]", err);
    ffmpegStarted = false;
    ffmpeg = null;
  });

  ffmpeg.on("close", function (code, signal) {
    log("[ffmpeg] closed code=", code, "signal=", signal);
    ffmpegStarted = false;
    ffmpeg = null;
  });
}

function ensureFfmpegForMime(mimeType) {
  startFfmpeg(mimeType || "audio/webm;codecs=opus");
}

function writeToFfmpeg(buffer, mimeType) {
  ensureFfmpegForMime(mimeType);

  if (!ffmpeg || !ffmpeg.stdin || ffmpeg.stdin.destroyed) {
    throw new Error("ffmpeg stdin is not available");
  }

  ffmpegBytesIn += buffer.length;

  const ok = ffmpeg.stdin.write(buffer);
  if (!ok) {
    log("[ffmpeg] stdin backpressure");
  }
}

function json(res, status, payload) {
  res.status(status).json(payload);
}

app.use(function (req, res, next) {
  applyCors(req, res);
  next();
});

app.get("/", function (req, res) {
  res.type("text/plain").send("EchoChannel ffmpeg relay running");
});

app.get("/health", function (req, res) {
  json(res, 200, {
    ok: true,
    live_clients: liveClients.size,
    recent_chunks: recentMp3Chunks.length,
    recent_buffer_bytes: recentMp3Bytes,
    last_mime_type: lastMimeType,
    last_chunk_at: lastChunkAt,
    ingest_count: ingestCount,
    ffmpeg_started: ffmpegStarted,
    ffmpeg_input_mime: ffmpegInputMime || null,
    ffmpeg_last_start_at: ffmpegLastStartAt || null,
    ffmpeg_bytes_in: ffmpegBytesIn,
    ffmpeg_bytes_out: ffmpegBytesOut
  });
});

app.get("/live.mp3", function (req, res) {
  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  if (recentMp3Chunks.length > 0) {
    recentMp3Chunks.forEach(function (chunk) {
      try {
        res.write(chunk);
      } catch (err) {}
    });
  }

  liveClients.add(res);
  log("[live.mp3] client connected, total =", liveClients.size);

  req.on("close", function () {
    liveClients.delete(res);
    log("[live.mp3] client disconnected, total =", liveClients.size);
    try { res.end(); } catch (e) {}
  });

  req.on("error", function () {
    liveClients.delete(res);
    try { res.end(); } catch (e) {}
  });
});

app.options("/ingest", function (req, res) {
  res.status(204).end();
});

app.post("/ingest", upload.single("audio"), function (req, res) {
  try {
    const file = req.file;
    const mimeType = String((req.body && req.body.mime_type) || (file && file.mimetype) || "").trim();
    const ts = String((req.body && req.body.ts) || "").trim();

    if (!file || !file.buffer || !file.buffer.length) {
      return json(res, 400, {
        ok: false,
        error: "Missing audio file in field 'audio'"
      });
    }

    lastMimeType = mimeType || file.mimetype || "application/octet-stream";
    lastChunkAt = Date.now();
    ingestCount += 1;

    writeToFfmpeg(file.buffer, lastMimeType);

    return json(res, 200, {
      ok: true,
      bytes: file.buffer.length,
      mime_type: lastMimeType,
      ts: ts || null,
      live_clients: liveClients.size
    });
  } catch (err) {
    console.error("[/ingest] error", err);
    return json(res, 500, {
      ok: false,
      error: "Ingest failed",
      message: err && err.message ? err.message : "Unknown error"
    });
  }
});

app.use(function (err, req, res, next) {
  console.error("[server error]", err);

  if (err && err.code === "LIMIT_FILE_SIZE") {
    return json(res, 413, {
      ok: false,
      error: "Uploaded chunk too large"
    });
  }

  return json(res, 500, {
    ok: false,
    error: "Server error"
  });
});

process.on("SIGTERM", function () {
  log("[process] SIGTERM received");
  stopFfmpeg();
  process.exit(0);
});

process.on("SIGINT", function () {
  log("[process] SIGINT received");
  stopFfmpeg();
  process.exit(0);
});

app.listen(PORT, function () {
  log("EchoChannel ffmpeg relay listening on port", PORT);
  log("Allowed origins:", ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : "[all]");
});
