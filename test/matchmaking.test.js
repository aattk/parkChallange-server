import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEnv, setupRoom, queueAll, tok } from './helpers.js';
import { MAPS } from '../src/maps.js';
import { createScoreStore } from '../src/scores.js';

test('two queued players are matched immediately', () => {
  const e = makeEnv();
  queueAll(e, ['a']);
  assert.deepEqual(e.last('a', 'queued'), { type: 'queued', waiting: 1 });
  e.advance(60_000);
  assert.equal(e.msgs('a', 'room').length, 0);
  queueAll(e, ['b']);
  const room = e.last('b', 'room');
  assert.equal(room.ranked, true);
  assert.equal(room.phase, 'countdown');
  assert.deepEqual(room.players.map((p) => [p.id, p.color, p.ready]), [['a', 0, true], ['b', 1, true]]);
  assert.ok(Object.hasOwn(MAPS, room.mapId));
  assert.equal(e.last('a', 'countdown').mapId, room.mapId);
  assert.equal(e.lobby.queue.length, 0);
  // room arrives before countdown so a menu client already knows its room
  const inbox = e.msgs('a').map((m) => m.type);
  assert.ok(inbox.lastIndexOf('room') < inbox.lastIndexOf('countdown'));
  e.advance(3000);
  assert.deepEqual(e.last('a', 'start'), { type: 'start', raceId: e.last('a', 'countdown').raceId, mapId: room.mapId, timeLimit: MAPS[room.mapId].timeLimit });
});

test('third queued player waits', () => {
  const e = makeEnv();
  queueAll(e, ['a', 'b', 'c']);
  assert.deepEqual(e.lobby.queue, ['c']);
  assert.deepEqual(e.last('c', 'queued'), { type: 'queued', waiting: 1 });
  assert.equal(e.msgs('c', 'room').length, 0);
  assert.deepEqual(e.last('a', 'room').players.map((p) => p.id), ['a', 'b']);
  e.advance(60_000);
  assert.equal(e.msgs('c', 'room').length, 0);
  queueAll(e, ['d']);
  assert.deepEqual(e.last('d', 'room').players.map((p) => p.id), ['c', 'd']);
  assert.equal(e.lobby.rooms.size, 2);
});

test('unqueue and disconnect leave the queue', () => {
  const e = makeEnv();
  queueAll(e, ['a']);
  e.send('a', { type: 'unqueue' });
  assert.deepEqual(e.lobby.queue, []);
  e.send('a', { type: 'unqueue' });
  assert.equal(e.last('a', 'error').code, 'not_in_queue');
  queueAll(e, ['c']);
  e.lobby.disconnect('c');
  assert.deepEqual(e.lobby.queue, []);
  e.send('a', { type: 'queue' });
  assert.deepEqual(e.last('a', 'queued'), { type: 'queued', waiting: 1 });
  assert.equal(e.timers.size, 0);
});

test('queue rules: no queue from a room, no rooms from the queue, double queue is harmless', () => {
  const e = makeEnv();
  setupRoom(e, ['a']);
  e.send('a', { type: 'queue' });
  assert.equal(e.last('a', 'error').code, 'already_in_room');
  queueAll(e, ['b']);
  e.send('b', { type: 'queue' });
  assert.deepEqual(e.lobby.queue, ['b']);
  e.send('b', { type: 'create', mapId: 'central-reverse' });
  assert.equal(e.last('b', 'error').code, 'in_queue');
  e.send('b', { type: 'join', code: 'ABCD' });
  assert.equal(e.last('b', 'error').code, 'in_queue');
});

test('ranked rooms cannot be joined by code, re-mapped or un-readied', () => {
  const e = makeEnv();
  queueAll(e, ['a', 'b']);
  const room = e.last('a', 'room');
  e.join('x');
  e.send('x', { type: 'join', code: room.code });
  assert.equal(e.last('x', 'error').code, 'ranked_room');
  e.send('a', { type: 'setMap', mapId: 'pillar-garage' });
  assert.equal(e.last('a', 'error').code, 'ranked_room');
  e.send('a', { type: 'ready', ready: false });
  assert.equal(e.last('a', 'error').code, 'ranked_room');
  assert.equal(e.lobby.rooms.get(room.code).phase, 'countdown');
});

test('random map comes from the injected random source', () => {
  const ids = Object.keys(MAPS);
  assert.equal(ids.length, 10);
  for (let i = 0; i < ids.length; i++) {
    const e = makeEnv({ random: () => (i + 0.5) / ids.length });
    queueAll(e, ['a', 'b']);
    assert.equal(e.last('a', 'room').mapId, ids[i]);
  }
});

test('disconnect during ranked countdown forfeits', () => {
  const e = makeEnv();
  queueAll(e, ['a', 'b']);
  const room = e.last('a', 'room');
  const raceId = e.last('a', 'countdown').raceId;
  e.lobby.disconnect('b');
  const res = e.last('a', 'results');
  assert.equal(res.raceId, raceId);
  assert.equal(res.ranked, true);
  assert.equal(res.scored, true);
  assert.equal(res.winnerId, 'a');
  assert.equal(res.reason, 'left');
  assert.deepEqual(res.standings.map((s) => [s.id, s.place, s.outcome, s.gained, s.total]), [['a', 1, 'win', 10, 10], ['b', 2, 'loss', 0, 0]]);
  // match is over: room gone, no start ever arrives
  assert.equal(e.lobby.rooms.has(room.code), false);
  assert.equal(e.lobby.players.get('a').roomCode, null);
  e.advance(10_000);
  assert.equal(e.msgs('a', 'start').length, 0);
  assert.equal(e.timers.size, 0);
});

test('leave during ranked countdown forfeits too; leaver gets no results', () => {
  const e = makeEnv();
  queueAll(e, ['a', 'b']);
  e.send('a', { type: 'leave' });
  assert.equal(e.msgs('a', 'results').length, 0);
  const res = e.last('b', 'results');
  assert.deepEqual([res.winnerId, res.reason], ['b', 'left']);
  e.send('a', { type: 'queue' });
  assert.deepEqual(e.lobby.queue, ['a']);
});

test('malformed tokens are ignored, not rejected', () => {
  const e = makeEnv();
  for (const bad of ['short', 'x'.repeat(65), 'has space!!', 42]) {
    const id = `p${String(bad).length}`;
    e.lobby.connect(id);
    e.send(id, { type: 'hello', name: 'N', protocol: 2, token: bad });
    assert.equal(e.last(id, 'welcome').points, 0);
    assert.equal(e.lobby.players.get(id).token, null);
  }
});

test('score store persists to disk and survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-scores-'));
  const file = path.join(dir, 'nested', 'scores.json');
  try {
    const a = createScoreStore({ file });
    a.recordRace([{ token: tok('a'), name: 'Ali', gained: 10, won: true }, { token: null, name: 'X', gained: 0, won: false }]);
    a.rename(tok('a'), 'Ali2');
    const b = createScoreStore({ file });
    assert.deepEqual(b.stats(tok('a')), { points: 10, wins: 1, races: 1 });
    assert.deepEqual(b.top(10), [{ name: 'Ali2', points: 10, wins: 1, races: 1 }]);
    fs.writeFileSync(file, '{not json');
    const logs = [];
    const c = createScoreStore({ file, log: (l) => logs.push(l) });
    assert.deepEqual(c.stats(tok('a')), { points: 0, wins: 0, races: 0 });
    assert.match(logs[0], /unreadable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unqueue is acknowledged', () => {
  const e = makeEnv();
  queueAll(e, ['a']);
  e.send('a', { type: 'unqueue' });
  assert.deepEqual(e.last('a'), { type: 'unqueued' });
  assert.deepEqual(e.lobby.queue, []);
  // already matched: no longer in the queue -> error, the match goes on
  queueAll(e, ['b', 'c']);
  e.send('b', { type: 'unqueue' });
  assert.equal(e.last('b', 'error').code, 'not_in_queue');
  assert.equal(e.msgs('b', 'unqueued').length, 0);
  assert.equal(e.last('b', 'room').phase, 'countdown');
});
