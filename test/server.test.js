import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../src/index.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  return {
    ws,
    open: new Promise((res) => ws.on('open', res)),
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next(pred) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for message')), 8000);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    type(t) { return this.next((m) => m.type === t); },
  };
}

test('integration: full private race with two real clients', async () => {
  const srv = startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  await new Promise((r) => srv.wss.on('listening', r));
  const port = srv.wss.address().port;
  try {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);

    // bad JSON and oversize frames get errors / are rejected without killing the server
    a.send('{not json');
    assert.equal((await a.type('error')).code, 'bad_request');

    a.send({ type: 'hello', name: 'Ali', protocol: 2 });
    b.send({ type: 'hello', name: 'Veli', protocol: 2 });
    const wa = await a.type('welcome');
    const wb = await b.type('welcome');
    a.send({ type: 'create', mapId: 'parallel-street' });
    const created = await a.type('room');
    b.send({ type: 'join', code: created.code.toLowerCase() });
    await b.next((m) => m.type === 'room' && m.players.length === 2);
    a.send({ type: 'ready', ready: true });
    b.send({ type: 'ready', ready: true });
    assert.equal((await a.type('countdown')).seconds, 3);
    const start = await b.type('start');
    assert.equal(start.timeLimit, 120);

    a.send({ type: 'pose', t: 0.1, x: 1, y: 2, r: 3, s: 4, p: 1.5 });
    const pose = await b.type('pose');
    assert.deepEqual(pose, { type: 'pose', id: wa.id, t: 0.1, x: 1, y: 2, r: 3, s: 4, p: 1 });
    a.send({ type: 'hit', hits: 1 });
    assert.deepEqual(await b.type('hit'), { type: 'hit', id: wa.id, hits: 1 });

    a.send({ type: 'fail', reason: 'bounds' });
    const res = await b.type('results');
    assert.equal(res.winnerId, wb.id);
    assert.equal(res.reason, 'bounds');
    assert.deepEqual(res.standings.map((s) => [s.id, s.place, s.outcome]), [[wb.id, 1, 'win'], [wa.id, 2, 'loss']]);
    assert.equal(res.raceId, start.raceId);
    assert.deepEqual(await a.type('results'), res);
    const lobby = await a.next((m) => m.type === 'room' && m.phase === 'lobby' && m.players.every((p) => !p.ready));
    assert.equal(lobby.players.length, 2);
    a.ws.close(); b.ws.close();
  } finally {
    await srv.close();
  }
});

test('integration: oversize frame closes only that socket', async () => {
  const srv = startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  await new Promise((r) => srv.wss.on('listening', r));
  const port = srv.wss.address().port;
  try {
    const a = client(port);
    await a.open;
    const closed = new Promise((r) => a.ws.on('close', r));
    a.ws.send('x'.repeat(2000));
    await closed;
    const b = client(port);
    await b.open;
    b.send({ type: 'hello', name: 'B', protocol: 2 });
    assert.equal((await b.type('welcome')).protocol, 2);
    b.ws.close();
  } finally {
    await srv.close();
  }
});

test('integration: pose rate limit drops extras', async () => {
  const srv = startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  await new Promise((r) => srv.wss.on('listening', r));
  const port = srv.wss.address().port;
  try {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ type: 'hello', name: 'A', protocol: 2 });
    b.send({ type: 'hello', name: 'B', protocol: 2 });
    await a.type('welcome'); await b.type('welcome');
    a.send({ type: 'create', mapId: 'central-reverse' });
    const { code } = await a.type('room');
    b.send({ type: 'join', code });
    await b.type('room');
    a.send({ type: 'ready', ready: true });
    b.send({ type: 'ready', ready: true });
    await b.type('start');
    let poses = 0;
    b.ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'pose') poses++; });
    for (let i = 0; i < 100; i++) a.send({ type: 'pose', t: i, x: 0, y: 0, r: 0, s: 0 });
    a.send({ type: 'fail', reason: 'bounds' });
    await b.type('results');
    assert.ok(poses >= 1 && poses <= 30, `relayed ${poses} poses`);
    a.ws.close(); b.ws.close();
  } finally {
    await srv.close();
  }
});

test('integration: quick match pairs two clients and persists points', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-srv-'));
  const scoresFile = path.join(dir, 'scores.json');
  const srv = startServer({ port: 0, host: '127.0.0.1', log: () => {}, scoresFile, timeLimitOverride: 30 });
  await new Promise((r) => srv.wss.on('listening', r));
  const port = srv.wss.address().port;
  try {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ type: 'hello', name: 'A', protocol: 1 });
    assert.equal((await a.type('error')).code, 'bad_protocol');
    a.send({ type: 'hello', name: 'A', protocol: 2, token: 'token-a-0000' });
    b.send({ type: 'hello', name: 'B', protocol: 2, token: 'token-b-0000' });
    const wa = await a.type('welcome');
    await b.type('welcome');
    a.send({ type: 'queue' });
    assert.deepEqual(await a.type('queued'), { type: 'queued', waiting: 1 });
    b.send({ type: 'queue' });
    const room = await b.type('room');
    assert.equal(room.ranked, true);
    assert.equal(room.players.length, 2);
    assert.equal((await a.type('start')).timeLimit, 30);
    b.ws.close();
    const res = await a.type('results');
    assert.deepEqual([res.winnerId, res.reason, res.scored], [wa.id, 'left', true]);
    assert.equal(res.standings[0].total, 10);
    const saved = JSON.parse(fs.readFileSync(scoresFile, 'utf8'));
    assert.deepEqual(saved.players['token-a-0000'], { name: 'A', points: 10, wins: 1, races: 1 });
    assert.deepEqual(saved.players['token-b-0000'], { name: 'B', points: 0, wins: 0, races: 1 });
    a.ws.close();
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
