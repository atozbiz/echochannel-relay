const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

let ffmpeg = null;
let ffmpegReady = false;
let sourceSocket = null;
let listeners = new Set();
let shuttingDown = false;

function log() {
  console.log.apply(console, arguments);
}

function addListener(res) {
  listeners.add(res);
  log("[http] listener connected:", listeners.size);
}

function removeListener(res) {
  if (listeners.has(res)) {
    listeners.delete(res);
    log("[http] listener disconnected:", listeners.size);
  }
}

function broadcast(chunk) {
  listeners.forEach(function (res) {
    try {
      res.write(chunk);
    } catch (e) {
      try {
        res.end();
      } catch (err) {}
      removeListener(res);
    }
  });
}

function stopFfmpeg() {
  if (!ffmpeg) return;

  try {
    ffmpeg.stdin.end();
  } catch (e) {}

  try {
    ffmpeg.kill("SIGTERM");
  } catch (e) {}

  ffmpeg = null;
  ffmpegReady = false;
}

function startFfmpeg() {
  stopFfmpeg();

  ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-vn",
    "-ac", "2",
    "-ar", "44100",
    "-b:a", "128k",
    "-f", "mp3",
    "pipe:1"
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  ffmpegReady = true;

  ffmpeg.stdout.on("data", function (chunk) {
    broadcast(chunk);
  });

  ffmpeg.stderr.on("data", function (chunk) {
    var text = String(chunk || "").trim();
    if (text) {
      log("[ffmpeg]", text);
    }
  });

  ffmpeg.on("close", function (code, signal) {
    log("[ffmpeg] closed", code, signal);
    ffmpeg = null;
    ffmpegReady = false;
  });

  ffmpeg.on("error", function (err) {
    log("[ffmpeg] error", err && err.message ? err.message : err);
    ffmpeg = null;
    ffmpegReady = false;
  });
}

function writeToFfmpeg(buffer) {
  if (!buffer || !buffer.length) return;

  if (!ffmpeg || !ffmpegReady) {
    startFfmpeg();
  }

  if (!ffmpeg || !ffmpeg.stdin || ffmpeg.stdin.destroyed) return;

  try {
    ffmpeg.stdin.write(buffer);
  } catch (e) {
    log("[relay] failed writing to ffmpeg:", e && e.message ? e.message : e);
  }
}

const server = http.createServer(function (req, res) {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      has_source: !!sourceSocket,
      listeners: listeners.size,
      ffmpeg_ready: !!ffmpegReady
    }));
    return;
  }

  if (req.url === "/live.mp3") {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    addListener(res);

    req.on("close", function () {
      removeListener(res);
    });

    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      "EchoChannel relay running\n\n" +
      "WebSocket ingest: wss://YOUR-DOMAIN\n" +
      "HTTP stream: https://YOUR-DOMAIN/live.mp3\n" +
      "Health: https://YOUR-DOMAIN/health\n"
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocket.Server({ server: server });

wss.on("connection", function (ws) {
  log("[ws] broadcaster connected");

  if (sourceSocket && sourceSocket !== ws) {
    try {
      sourceSocket.close(1013, "Another broadcaster connected");
    } catch (e) {}
  }

  sourceSocket = ws;

  ws.on("message", function (data) {
    if (!data) return;

    var buffer = null;

    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data);
    } else if (ArrayBuffer.isView(data)) {
      buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else {
      return;
    }

    if (!buffer.length) return;
    writeToFfmpeg(buffer);
  });

  ws.on("close", function () {
    log("[ws] broadcaster disconnected");
    if (sourceSocket === ws) {
      sourceSocket = null;
    }
    stopFfmpeg();
  });

  ws.on("error", function (err) {
    log("[ws] error", err && err.message ? err.message : err);
  });
});

server.listen(PORT, function () {
  log("EchoChannel relay listening on port", PORT);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  listeners.forEach(function (res) {
    try {
      res.end();
    } catch (e) {}
  });
  listeners.clear();

  try {
    wss.close();
  } catch (e) {}

  try {
    server.close();
  } catch (e) {}

  stopFfmpeg();

  setTimeout(function () {
    process.exit(0);
  }, 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
