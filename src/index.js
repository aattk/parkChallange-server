import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createLobby } from './rooms.js';
import { createScoreStore } from './scores.js';

const MAX_POSES_PER_SEC = 30;
const HEARTBEAT_MS = 15000;

// scoresFile: JSON path for persistent ranked points; null keeps them in memory (tests).
// timeLimitOverride: seconds replacing every map's timeLimit (test/e2e only; env RACE_TIME_LIMIT_OVERRIDE).
export function startServer({ port = 8787, host = '0.0.0.0', log = console.log, heartbeatMs = HEARTBEAT_MS, scoresFile = null, timeLimitOverride = null } = {}) {
  const wss = new WebSocketServer({ port, host, maxPayload: 1024 });
  const sockets = new Map();
  let nextId = 1;

  const lobby = createLobby({
    now: Date.now,
    setTimeout,
    clearTimeout,
    log,
    scores: createScoreStore({ file: scoresFile, log }),
    timeLimitOverride,
    send(id, msg) {
      const ws = sockets.get(id);
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  });

  wss.on('connection', (ws, req) => {
    const id = `p${nextId++}`;
    sockets.set(id, ws);
    lobby.connect(id);
    ws.isAlive = true;
    let poseWindowStart = 0;
    let poseCount = 0;
    log(`connect ${id} from ${req.socket.remoteAddress}`);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (isBinary) return lobby.message(id, null);
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return lobby.message(id, undefined); // -> bad_request error
      }
      if (msg && msg.type === 'pose') {
        const t = Date.now();
        if (t - poseWindowStart >= 1000) { poseWindowStart = t; poseCount = 0; }
        if (++poseCount > MAX_POSES_PER_SEC) return;
      }
      try {
        lobby.message(id, msg);
      } catch (e) {
        log(`error handling message from ${id}: ${e?.stack ?? e}`);
      }
    });
    ws.on('error', (e) => log(`socket error ${id}: ${e.message}`));
    ws.on('close', () => {
      sockets.delete(id);
      try { lobby.disconnect(id); } catch (e) { log(`disconnect error ${id}: ${e?.stack ?? e}`); }
      log(`disconnect ${id}`);
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  wss.on('close', () => clearInterval(hb));

  return { wss, lobby, close: () => new Promise((res) => { clearInterval(hb); for (const c of wss.clients) c.terminate(); wss.close(() => res()); }) };
}

function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) urls.push(`ws://${i.address}:${port}`);
  }
  return urls;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const scoresFile = process.env.SCORES_FILE || fileURLToPath(new URL('../data/scores.json', import.meta.url));
  const timeLimitOverride = Number(process.env.RACE_TIME_LIMIT_OVERRIDE) || null;
  const server = startServer({ port, scoresFile, timeLimitOverride, log: (l) => console.log(`${new Date().toISOString()} ${l}`) });
  server.wss.on('listening', () => {
    console.log(`park-race-server listening on port ${port} (protocol 2)`);
    if (timeLimitOverride) console.log(`  TEST MODE: every map timeLimit = ${timeLimitOverride}s (RACE_TIME_LIMIT_OVERRIDE)`);
    console.log(`  ws://localhost:${port}`);
    for (const u of lanUrls(port)) console.log(`  ${u}`);
  });
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
