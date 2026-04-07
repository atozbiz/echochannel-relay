// server.js
//
// Keeps existing /live.mp3 relay behavior
// Adds:
//   - POST /ingest
//   - OPTIONS /ingest for CORS preflight
//   - browser CORS headers
//   - multipart/form-data support for MediaRecorder uploads
//
// Expected multipart fields:
//   - audio      (file blob)
//   - mime_type  (string)
//   - ts         (string / timestamp)
//
// Notes:
// - This relay streams uploaded chunks directly to all connected /live.mp3 listeners.
// - It also keeps a small rolling memory buffer so newly connected listeners can receive
//   the most recent audio immediately.
// - For Sonos compatibility, the broadcaster should ideally send MP3-compatible audio.
//   This server does not transcode; it relays bytes as received.

const express = require("express");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// Comma-separated list of allowed origins, for example:
// ALLOWED_ORIGINS=https://your-base44-app.com,https://preview.base44.app
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Rolling in-memory buffer settings
const MAX_BUFFER_BYTES = Number(process.env.MAX_BUFFER_BYTES || 5 * 1024 * 1024); // 5 MB
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024); // 2 MB

// -----------------------------------------------------------------------------
// Multipart handling
// -----------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
});

// -----------------------------------------------------------------------------
// In-memory live relay state
// -----------------------------------------------------------------------------

// Connected /live.mp3 listeners
const liveClients = new Set();

// Rolling buffer of recent audio chunks for new listeners
let recentChunks = [];
let recentChunksBytes = 0;

// Track last seen mime type from ingest
let lastMimeType = "audio/mpeg";
let lastChunkAt = 0;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser or curl
  if (ALLOWED_ORIGINS.length === 0) return true; // allow all if not configured
  return ALLOWED_ORIGINS.includes(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function addRecentChunk(buffer) {
  if (!buffer || !buffer.length) return;

  recentChunks.push(buffer);
  recentChunksBytes += buffer.length;

  while (recentChunksBytes > MAX_BUFFER_BYTES && recentChunks.length > 0) {
    const removed = recentChunks.shift();
    recentChunksBytes -= removed.length;
  }
}

function broadcastChunk(buffer) {
  if (!buffer || !buffer.length) return;

  for (const client of liveClients) {
    try {
      client.write(buffer);
    } catch (err) {
      try {
        client.end();
      } catch (_) {}
      liveClients.delete(client);
    }
  }
}

function json(res, status, payload) {
  res.status(status).json(payload);
}

// -----------------------------------------------------------------------------
// Basic routes
// -----------------------------------------------------------------------------

app.get("/", function (req, res) {
  res.type("text/plain").send("EchoChannel relay running");
});

app.get("/health", function (req, res) {
  json(res, 200, {
    ok: true,
    live_clients: liveClients.size,
    recent_chunks: recentChunks.length,
    recent_buffer_bytes: recentChunksBytes,
    last_mime_type: lastMimeType,
    last_chunk_at: lastChunkAt || null,
  });
});

// -----------------------------------------------------------------------------
// /live.mp3
// Keeps a chunked HTTP response open for listeners (e.g. Sonos)
// -----------------------------------------------------------------------------

app.get("/live.mp3", function (req, res) {
  // Keep content-type as audio/mpeg because the working Sonos URL is /live.mp3
  // and the existing behavior must remain stable.
  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Some proxies behave better when headers are flushed immediately
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  // Push recent buffered chunks first so a new listener has immediate data
  if (recentChunks.length > 0) {
    for (const chunk of recentChunks) {
      try {
        res.write(chunk);
      } catch (err) {
        try {
          res.end();
        } catch (_) {}
        return;
      }
    }
  }

  liveClients.add(res);

  req.on("close", function () {
    liveClients.delete(res);
    try {
      res.end();
    } catch (_) {}
  });

  req.on("error", function () {
    liveClients.delete(res);
    try {
      res.end();
    } catch (_) {}
  });
});

// -----------------------------------------------------------------------------
// /ingest
// Receives browser mic chunks as multipart/form-data
// -----------------------------------------------------------------------------

app.options("/ingest", function (req, res) {
  applyCors(req, res);
  res.status(204).end();
});

app.post("/ingest", function (req, res, next) {
  applyCors(req, res);
  next();
}, upload.single("audio"), function (req, res) {
  try {
    const file = req.file;
    const mimeType = String(req.body && req.body.mime_type ? req.body.mime_type : "").trim();
    const ts = String(req.body && req.body.ts ? req.body.ts : "").trim();

    if (!file || !file.buffer || !file.buffer.length) {
      return json(res, 400, { ok: false, error: "Missing audio file in field 'audio'" });
    }

    if (mimeType) {
      lastMimeType = mimeType;
    }

    lastChunkAt = Date.now();

    // Store in rolling memory buffer for new /live.mp3 listeners
    addRecentChunk(file.buffer);

    // Stream immediately to all connected listeners
    broadcastChunk(file.buffer);

    return json(res, 200, {
      ok: true,
      bytes: file.buffer.length,
      mime_type: mimeType || file.mimetype || null,
      ts: ts || null,
      listeners: liveClients.size,
    });
  } catch (err) {
    console.error("[/ingest] error:", err);
    return json(res, 500, { ok: false, error: "Ingest failed" });
  }
});

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

app.use(function (err, req, res, next) {
  applyCors(req, res);

  if (err && err.code === "LIMIT_FILE_SIZE") {
    return json(res, 413, {
      ok: false,
      error: "Uploaded audio chunk is too large",
    });
  }

  console.error("[server] uncaught error:", err);
  return json(res, 500, {
    ok: false,
    error: "Server error",
  });
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

app.listen(PORT, function () {
  console.log("EchoChannel relay listening on port " + PORT);
  console.log("Allowed origins:", ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : "[all]");
});
