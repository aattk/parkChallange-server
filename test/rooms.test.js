import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, setupRoom, startRace } from './helpers.js';

test('hello required before anything else', () => {
  const e = makeEnv();
  e.lobby.connect('a');
  e.send('a', { type: 'create', mapId: 'central-reverse' });
  assert.equal(e.last('a', 'error').code, 'hello_required');
  e.send('a', { type: 'hello', name: '  ', protocol: 2 });
  assert.equal(e.last('a', 'error').code, 'bad_name');
  e.send('a', { type: 'hello', name: 'x'.repeat(17), protocol: 2 });
  assert.equal(e.last('a', 'error').code, 'bad_name');
  e.send('a', { type: 'hello', name: ' Ali ', protocol: 2 });
  assert.deepEqual(e.last('a', 'welcome'), { type: 'welcome', id: 'a', protocol: 2, points: 0, wins: 0, races: 0 });
  e.send('a', { type: 'hello', name: 'Ali', protocol: 2 });
  assert.equal(e.last('a', 'error').code, 'already_hello');
  e.send('a', { type: 'create', mapId: 'central-reverse' });
  assert.equal(e.last('a', 'room').players[0].name, 'Ali');
});

test('protocol 1 rejected', () => {
  const e = makeEnv();
  e.lobby.connect('a');
  for (const protocol of [1, undefined, '2', 3]) {
    e.send('a', { type: 'hello', name: 'Ali', protocol });
    assert.equal(e.last('a', 'error').code, 'bad_protocol');
  }
  assert.equal(e.msgs('a', 'welcome').length, 0);
  e.send('a', { type: 'queue' });
  assert.equal(e.last('a', 'error').code, 'hello_required');
});

test('create, join, leave', () => {
  const e = makeEnv();
  const code = setupRoom(e, ['a', 'b']);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  const room = e.last('b', 'room');
  assert.equal(room.hostId, 'a');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.ranked, false);
  assert.deepEqual(room.players.map((p) => [p.id, p.color, p.status, p.time, p.ready]), [['a', 0, 'lobby', -1, false], ['b', 1, 'lobby', -1, false]]);
  e.send('a', { type: 'create', mapId: 'pillar-garage' });
  assert.equal(e.last('a', 'error').code, 'already_in_room');
  e.send('b', { type: 'leave' });
  assert.equal(e.last('a', 'room').players.length, 1);
  e.send('b', { type: 'leave' });
  assert.equal(e.last('b', 'error').code, 'not_in_room');
  e.send('a', { type: 'leave' });
  assert.equal(e.lobby.rooms.size, 0);
});

test('join code is case-insensitive; unknown code errors', () => {
  const e = makeEnv();
  const code = setupRoom(e, ['a']);
  e.join('b');
  e.send('b', { type: 'join', code: ` ${code.toLowerCase()} ` });
  assert.equal(e.last('b', 'room').code, code);
  e.join('c');
  e.send('c', { type: 'join', code: 'ZZZZ' });
  assert.equal(e.last('c', 'error').code, 'room_not_found');
  e.send('c', { type: 'join', code: 12 });
  assert.equal(e.last('c', 'error').code, 'bad_request');
});

test('private room rejects third player', () => {
  const e = makeEnv();
  const code = setupRoom(e, ['a', 'b']);
  e.join('c');
  e.send('c', { type: 'join', code });
  assert.equal(e.last('c', 'error').code, 'room_full');
  assert.equal(e.lobby.players.get('c').roomCode, null);
  assert.equal(e.last('a', 'room').players.length, 2);
  // a free seat opens again after a leave; the newcomer takes the free color
  e.send('a', { type: 'leave' });
  e.send('c', { type: 'join', code });
  assert.deepEqual(e.last('c', 'room').players.map((p) => [p.id, p.color]), [['b', 1], ['c', 0]]);
});

test('private countdown needs two ready players', () => {
  const e = makeEnv();
  const code = setupRoom(e, ['a'], 'pillar-garage');
  e.send('a', { type: 'ready', ready: true });
  e.advance(10_000);
  assert.equal(e.msgs('a', 'countdown').length, 0);
  assert.equal(e.last('a', 'room').phase, 'lobby');
  e.join('b');
  e.send('b', { type: 'join', code });
  assert.equal(e.msgs('a', 'countdown').length, 0);
  e.send('b', { type: 'ready', ready: true });
  const cd = e.last('a', 'countdown');
  assert.deepEqual(cd, { type: 'countdown', raceId: cd.raceId, mapId: 'pillar-garage', seconds: 3 });
  assert.equal(e.last('b', 'room').phase, 'countdown');
  e.advance(2999);
  assert.equal(e.msgs('a', 'start').length, 0);
  e.advance(1);
  assert.deepEqual(e.last('b', 'start'), { type: 'start', raceId: cd.raceId, mapId: 'pillar-garage', timeLimit: 120 });
  const room = e.last('a', 'room');
  assert.equal(room.phase, 'racing');
  assert.ok(room.players.every((p) => p.status === 'racing'));
});

test('private countdown: unready cancels, leave cancels without results', () => {
  const e = makeEnv();
  setupRoom(e, ['a', 'b']);
  e.send('a', { type: 'ready', ready: true });
  e.send('b', { type: 'ready', ready: true });
  e.send('b', { type: 'ready', ready: false });
  assert.equal(e.last('a', 'room').phase, 'lobby');
  assert.equal(e.last('a', 'room').players[0].ready, true);
  e.advance(5000);
  assert.equal(e.msgs('a', 'start').length, 0);
  e.send('b', { type: 'ready', ready: true });
  assert.equal(e.last('a', 'room').phase, 'countdown');
  e.send('b', { type: 'leave' });
  const room = e.last('a', 'room');
  assert.equal(room.phase, 'lobby');
  assert.deepEqual(room.players.map((p) => [p.id, p.ready]), [['a', false]]);
  e.lobby.disconnect('a');
  e.advance(5000);
  assert.equal(e.msgs('a', 'start').length, 0);
  assert.equal(e.msgs('a', 'results').length + e.msgs('b', 'results').length, 0);
  assert.equal(e.lobby.rooms.size, 0);
  assert.equal(e.timers.size, 0);
});

test('setMap is host-only, lobby-only, validated', () => {
  const e = makeEnv();
  setupRoom(e, ['a', 'b']);
  e.send('b', { type: 'setMap', mapId: 'pillar-garage' });
  assert.equal(e.last('b', 'error').code, 'not_host');
  e.send('a', { type: 'setMap', mapId: 'nope' });
  assert.equal(e.last('a', 'error').code, 'unknown_map');
  e.send('a', { type: 'setMap', mapId: 'double-parked' });
  assert.equal(e.last('b', 'room').mapId, 'double-parked');
  e.send('a', { type: 'ready', ready: true });
  e.send('b', { type: 'ready', ready: true });
  e.send('a', { type: 'setMap', mapId: 'parallel-street' });
  assert.equal(e.last('a', 'error').code, 'not_lobby');
  assert.equal(e.last('a', 'room').mapId, 'double-parked');
});

test('create with unknown map is refused', () => {
  const e = makeEnv();
  e.join('a');
  e.send('a', { type: 'create', mapId: '__proto__' });
  assert.equal(e.last('a', 'error').code, 'unknown_map');
  e.send('a', { type: 'create' });
  assert.equal(e.last('a', 'error').code, 'unknown_map');
});

test('host migration to remaining member', () => {
  const e = makeEnv();
  setupRoom(e, ['a', 'b']);
  e.send('a', { type: 'leave' });
  assert.equal(e.last('b', 'room').hostId, 'b');
});

test('pose p is relayed and clamped', () => {
  const e = makeEnv();
  setupRoom(e, ['a', 'b']);
  e.send('a', { type: 'pose', t: 0, x: 1, y: 2, r: 3, s: 4, p: 0.5 });
  assert.equal(e.msgs('b', 'pose').length, 0); // lobby
  e.send('a', { type: 'ready', ready: true });
  e.send('b', { type: 'ready', ready: true });
  e.send('a', { type: 'pose', t: 0, x: 1, y: 2, r: 3, s: 4, p: 0.5 }); // countdown
  e.advance(3000);
  assert.equal(e.msgs('b', 'pose').length, 0);
  e.send('a', { type: 'pose', t: 0.5, x: 1, y: 2, r: 3, s: 4, p: 0.25 });
  assert.deepEqual(e.last('b', 'pose'), { type: 'pose', id: 'a', t: 0.5, x: 1, y: 2, r: 3, s: 4, p: 0.25 });
  e.send('a', { type: 'pose', t: 0.6, x: 1, y: 2, r: 3, s: 4, p: 7 });
  assert.equal(e.last('b', 'pose').p, 1);
  e.send('a', { type: 'pose', t: 0.7, x: 1, y: 2, r: 3, s: 4, p: -3 });
  assert.equal(e.last('b', 'pose').p, 0);
  e.send('a', { type: 'pose', t: 0.8, x: 1, y: 2, r: 3, s: 4 }); // p optional
  assert.equal(e.last('b', 'pose').p, 0);
  e.send('a', { type: 'pose', t: 0.9, x: 1, y: 2, r: 3, s: 4, p: 'x' });
  assert.equal(e.last('b', 'pose').p, 0);
  assert.equal(e.msgs('b', 'pose').length, 5);
  assert.equal(e.msgs('a', 'pose').length, 0); // never echoed
});

test('hit is relayed to opponent', () => {
  const e = makeEnv();
  startRace(e);
  e.send('a', { type: 'hit', hits: 1 });
  assert.deepEqual(e.last('b', 'hit'), { type: 'hit', id: 'a', hits: 1 });
  assert.equal(e.msgs('a', 'hit').length, 0);
  e.send('a', { type: 'hit', hits: 1 }); // repeat ignored
  e.send('a', { type: 'hit', hits: 0 }); // invalid
  assert.equal(e.last('a', 'error').code, 'bad_request');
  e.send('a', { type: 'hit', hits: 2 });
  e.send('a', { type: 'hit', hits: 1 }); // going backwards ignored
  assert.deepEqual(e.msgs('b', 'hit').map((m) => m.hits), [1, 2]);
  assert.equal(e.last('b', 'room').phase, 'racing');
  assert.equal(e.msgs('b', 'results').length, 0);
});

test('hit before the race starts is ignored', () => {
  const e = makeEnv();
  setupRoom(e, ['a', 'b']);
  e.send('a', { type: 'ready', ready: true });
  e.send('b', { type: 'ready', ready: true });
  e.send('a', { type: 'hit', hits: 3 });
  assert.equal(e.msgs('b', 'hit').length, 0);
  assert.equal(e.msgs('a', 'error').length, 0);
  e.advance(3000);
  assert.equal(e.last('a', 'room').phase, 'racing');
});

test('invalid inputs do not crash', () => {
  const e = makeEnv();
  startRace(e);
  const junk = [
    null, undefined, 5, 'str', [], {}, { type: 5 }, { type: 'nope' }, { type: '__proto__' }, { type: 'constructor' },
    { type: 'pose', t: NaN, x: 1, y: 1, r: 1, s: 1 }, { type: 'pose', t: 'a', x: 1, y: 1, r: 1, s: 1 },
    { type: 'pose', t: Infinity, x: 1, y: 1, r: 1, s: 1 }, { type: 'pose' },
    { type: 'hit' }, { type: 'hit', hits: 1.5 }, { type: 'hit', hits: '2' }, { type: 'hit', hits: -1 },
    { type: 'finish', time: NaN, hits: 0 }, { type: 'finish', time: 1, hits: 1.5 }, { type: 'finish', time: '1', hits: 0 },
    { type: 'finish', time: 1, hits: -1 }, { type: 'finish' }, { type: 'fail' }, { type: 'fail', reason: 5 },
    { type: 'fail', reason: 'hits' }, { type: 'fail', reason: 'time' },
    { type: 'ready', ready: 'yes' }, { type: 'join', code: {} }, { type: 'setMap', mapId: {} }, { type: 'hello', name: 5 },
  ];
  for (const m of junk) e.send('a', m);
  e.lobby.message('ghost', { type: 'hello', name: 'x', protocol: 2 });
  assert.equal(e.last('a', 'room').players.find((p) => p.id === 'a').status, 'racing');
  assert.equal(e.msgs('b', 'pose').length, 0);
  assert.equal(e.msgs('b', 'hit').length, 0);
  assert.equal(e.msgs('b', 'results').length, 0);
});

test('names with < or > are rejected', () => {
  const e = makeEnv();
  e.lobby.connect('a');
  for (const name of ['<b>Ali</b>', 'a>b', '<color=red>']) {
    e.send('a', { type: 'hello', name, protocol: 2 });
    assert.equal(e.last('a', 'error').code, 'bad_name');
  }
  assert.equal(e.msgs('a', 'welcome').length, 0);
  e.send('a', { type: 'hello', name: 'Ali & Veli', protocol: 2 });
  assert.equal(e.last('a', 'welcome').id, 'a');
});
