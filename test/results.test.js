import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, startRace, startRanked, queueAll, tok } from './helpers.js';
import { MAPS } from '../src/maps.js';

const summary = (res) => res.standings.map((s) => [s.id, s.place, s.outcome, s.status, s.time, s.hits, s.gained]);

test('first finish wins and ends race', () => {
  const e = makeEnv();
  startRace(e);
  e.advance(10_000);
  e.send('b', { type: 'hit', hits: 1 });
  e.send('a', { type: 'finish', time: 9.9, hits: 0 });
  const res = e.last('b', 'results');
  assert.deepEqual(e.last('a', 'results'), res);
  assert.equal(res.winnerId, 'a');
  assert.equal(res.reason, 'parked');
  assert.equal(res.ranked, false);
  assert.equal(res.scored, false);
  assert.deepEqual(summary(res), [['a', 1, 'win', 'finished', 9.9, 0, 0], ['b', 2, 'loss', 'dnf', -1, 1, 0]]);
  assert.deepEqual(Object.keys(res).sort(), ['mapId', 'raceId', 'ranked', 'reason', 'scored', 'standings', 'type', 'winnerId']);
  assert.deepEqual(Object.keys(res.standings[0]).sort(), ['color', 'gained', 'hits', 'id', 'name', 'outcome', 'place', 'status', 'time', 'total']);
  // the second finish arrives late: silently ignored, no second results
  e.send('b', { type: 'finish', time: 10, hits: 1 });
  assert.equal(e.msgs('b', 'results').length, 1);
  assert.equal(e.msgs('b', 'error').length, 0);
  // private room goes back to the lobby for a rematch
  const room = e.last('a', 'room');
  assert.equal(room.phase, 'lobby');
  assert.ok(room.players.every((p) => !p.ready && p.status === 'lobby' && p.time === -1 && p.hits === 0));
  assert.equal(e.timers.size, 0);
});

test('third hit loses immediately', () => {
  const e = makeEnv();
  startRanked(e);
  e.advance(5000);
  e.send('a', { type: 'hit', hits: 1 });
  e.send('a', { type: 'hit', hits: 2 });
  assert.equal(e.msgs('a', 'results').length, 0);
  e.send('a', { type: 'hit', hits: 3 });
  assert.deepEqual(e.last('b', 'hit'), { type: 'hit', id: 'a', hits: 3 });
  const res = e.last('b', 'results');
  assert.deepEqual([res.winnerId, res.reason], ['b', 'hits']);
  assert.deepEqual(summary(res), [['b', 1, 'win', 'dnf', -1, 0, 10], ['a', 2, 'loss', 'dnf', -1, 3, 0]]);
  // hit relayed before results
  const types = e.msgs('b').map((m) => m.type);
  assert.ok(types.lastIndexOf('hit') < types.lastIndexOf('results'));
  assert.equal(e.lobby.rooms.size, 0);
});

test('hits above the limit are clamped and still lose', () => {
  const e = makeEnv();
  startRace(e);
  e.send('b', { type: 'hit', hits: 9 });
  assert.equal(e.last('a', 'hit').hits, 3);
  assert.deepEqual([e.last('a', 'results').winnerId, e.last('a', 'results').reason], ['a', 'hits']);
});

test('bounds loses', () => {
  const e = makeEnv();
  startRanked(e);
  e.advance(4000);
  e.send('b', { type: 'fail', reason: 'bounds' });
  const res = e.last('a', 'results');
  assert.deepEqual([res.winnerId, res.reason], ['a', 'bounds']);
  assert.deepEqual(summary(res).map((s) => s.slice(0, 3)), [['a', 1, 'win'], ['b', 2, 'loss']]);
});

test('fail reasons other than bounds are bad requests', () => {
  const e = makeEnv();
  startRace(e);
  for (const reason of ['hits', 'time', '', undefined]) {
    e.send('a', { type: 'fail', reason });
    assert.equal(e.last('a', 'error').code, 'bad_request');
  }
  assert.equal(e.msgs('a', 'results').length, 0);
});

test('leaving during race forfeits', () => {
  const e = makeEnv();
  startRace(e);
  e.advance(5000);
  e.send('a', { type: 'hit', hits: 1 });
  e.send('a', { type: 'leave' });
  assert.equal(e.msgs('a', 'results').length, 0); // leaver who sent leave gets nothing
  const res = e.last('b', 'results');
  assert.deepEqual([res.winnerId, res.reason, res.scored], ['b', 'left', false]);
  assert.deepEqual(summary(res), [['b', 1, 'win', 'dnf', -1, 0, 0], ['a', 2, 'loss', 'dnf', -1, 1, 0]]);
  const room = e.last('b', 'room');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.hostId, 'b');
  assert.deepEqual(room.players.map((p) => p.id), ['b']);
  assert.equal(e.timers.size, 0);
});

test('disconnect during ranked race forfeits and scores', () => {
  const e = makeEnv();
  startRanked(e);
  e.lobby.disconnect('a');
  const res = e.last('b', 'results');
  assert.deepEqual([res.winnerId, res.reason, res.scored], ['b', 'left', true]);
  assert.deepEqual(summary(res).map((s) => s.slice(0, 3)), [['b', 1, 'win'], ['a', 2, 'loss']]);
  e.join('z', 'A', tok('a'));
  assert.deepEqual(e.last('z', 'welcome'), { type: 'welcome', id: 'z', protocol: 2, points: 0, wins: 0, races: 1 });
});

test('both disconnecting deletes the room without crash', () => {
  const e = makeEnv();
  startRace(e);
  e.lobby.disconnect('a');
  e.lobby.disconnect('b');
  assert.equal(e.lobby.rooms.size, 0);
  assert.equal(e.timers.size, 0);
  const r = makeEnv();
  startRanked(r);
  r.lobby.disconnect('a');
  r.lobby.disconnect('b');
  assert.equal(r.lobby.rooms.size, 0);
  assert.equal(r.timers.size, 0);
});

test('timeout is a draw with no points', () => {
  const e = makeEnv({ random: () => 0 }); // central-reverse, 90 s
  startRanked(e);
  assert.equal(e.last('a', 'start').timeLimit, 90);
  e.send('a', { type: 'hit', hits: 2 });
  e.advance(90_999);
  assert.equal(e.msgs('b', 'results').length, 0);
  e.advance(1);
  const res = e.last('b', 'results');
  assert.deepEqual([res.winnerId, res.reason, res.ranked, res.scored], ['', 'time', true, true]);
  assert.deepEqual(summary(res), [['a', 1, 'draw', 'dnf', -1, 2, 0], ['b', 1, 'draw', 'dnf', -1, 0, 0]]);
  // a draw still counts as a race for both, but no win and no points
  e.lobby.disconnect('b'); // a token is scored on one live connection only
  e.join('z', 'Z', tok('b'));
  assert.deepEqual(e.last('z', 'welcome'), { type: 'welcome', id: 'z', protocol: 2, points: 0, wins: 0, races: 1 });
  e.send('a', { type: 'finish', time: 91, hits: 0 }); // after the end: ignored silently
  assert.equal(e.msgs('a', 'error').length, 0);
});

test('timeLimitOverride replaces every map limit (test mode)', () => {
  const e = makeEnv({ timeLimitOverride: 4 });
  startRace(e, ['a', 'b'], 'double-parked');
  assert.equal(e.last('a', 'start').timeLimit, 4);
  e.advance(5000);
  assert.equal(e.last('a', 'results').reason, 'time');
});

test('late or too-fast finish rejected', () => {
  const e = makeEnv();
  startRace(e); // central-reverse, 90 s
  e.advance(2000);
  e.send('a', { type: 'finish', time: 2, hits: 0 }); // below MIN_FINISH_TIME
  assert.equal(e.last('a', 'error').code, 'finish_rejected');
  e.advance(2000);
  e.send('a', { type: 'finish', time: 0.5, hits: 0 }); // clamped up to 2.5 s, still below 3
  assert.equal(e.last('a', 'error').code, 'finish_rejected');
  assert.equal(e.msgs('a', 'error').length, 2);
  e.send('a', { type: 'hit', hits: 2 });
  e.send('b', { type: 'finish', time: 4, hits: 3 }); // claims 3 hits -> rejected
  assert.equal(e.last('b', 'error').code, 'finish_rejected');
  assert.equal(e.msgs('a', 'results').length, 0);
  assert.equal(e.last('a', 'room').phase, 'racing');

  const l = makeEnv();
  startRace(l);
  l.advance(90_999); // timeLimit + END_GRACE (91 s) is the hard end; just before it a finish is still accepted
  l.send('a', { type: 'finish', time: 90.9, hits: 0 });
  assert.equal(l.last('b', 'results').reason, 'parked');

  // a finish claimed far beyond the clamp window is pulled back to server time
  const c = makeEnv();
  startRace(c);
  c.advance(10_000);
  c.send('b', { type: 'finish', time: 99, hits: 0 });
  assert.equal(c.last('a', 'results').standings[0].time, 10.25);
  const f = makeEnv();
  startRace(f);
  f.advance(10_000);
  f.send('b', { type: 'finish', time: 1, hits: 0 });
  assert.equal(f.last('a', 'results').standings[0].time, 8.5);
});

test('finish after hitting the limit is impossible', () => {
  const e = makeEnv();
  startRace(e);
  e.advance(5000);
  e.send('a', { type: 'hit', hits: 3 });
  e.send('a', { type: 'finish', time: 5, hits: 3 });
  assert.equal(e.msgs('a', 'results').length, 1);
  assert.equal(e.last('a', 'results').winnerId, 'b');
});

test('winner gets 10 points, loser 0', () => {
  const e = makeEnv();
  startRanked(e);
  e.advance(12_000);
  e.send('b', { type: 'finish', time: 12, hits: 1 });
  const res = e.last('a', 'results');
  assert.deepEqual([res.winnerId, res.reason, res.ranked, res.scored], ['b', 'parked', true, true]);
  assert.deepEqual(res.standings.map((s) => [s.id, s.outcome, s.gained, s.total]), [['b', 'win', 10, 10], ['a', 'loss', 0, 0]]);
  assert.equal(e.lobby.rooms.size, 0);
  assert.ok(['a', 'b'].every((id) => e.lobby.players.get(id).roomCode === null));
  // play again straight away; points carry over and leaderboard is sorted
  e.send('a', { type: 'queue' });
  e.send('b', { type: 'queue' });
  e.advance(3000 + 5000);
  e.send('b', { type: 'finish', time: 5, hits: 0 });
  assert.deepEqual(e.last('a', 'results').standings.map((s) => [s.id, s.gained, s.total]), [['b', 10, 20], ['a', 0, 0]]);
  e.send('a', { type: 'leaderboard' });
  assert.deepEqual(e.last('a', 'leaderboard').entries.map((x) => [x.name, x.points, x.wins, x.races]), [['B', 20, 2, 2], ['A', 0, 0, 2]]);
  e.lobby.disconnect('b');
  e.join('z', 'Z', tok('b'));
  assert.deepEqual(e.last('z', 'welcome'), { type: 'welcome', id: 'z', protocol: 2, points: 20, wins: 2, races: 2 });
});

test('private rooms and tokenless players are never scored', () => {
  const p = makeEnv();
  startRace(p);
  p.advance(5000);
  p.send('a', { type: 'finish', time: 5, hits: 0 });
  const priv = p.last('a', 'results');
  assert.equal(priv.scored, false);
  assert.ok(priv.standings.every((s) => s.gained === 0 && s.total === 0));
  p.send('a', { type: 'leaderboard' });
  assert.deepEqual(p.last('a', 'leaderboard').entries, []);

  const n = makeEnv();
  startRanked(n, ['a', 'b'], false);
  n.advance(5000);
  n.send('a', { type: 'finish', time: 5, hits: 0 });
  const anon = n.last('a', 'results');
  assert.deepEqual(anon.standings.map((s) => [s.outcome, s.gained, s.total]), [['win', 0, 0], ['loss', 0, 0]]);
  n.send('a', { type: 'leaderboard' });
  assert.deepEqual(n.last('a', 'leaderboard').entries, []);
});

test('every map can be raced with its own time limit', () => {
  for (const map of Object.values(MAPS)) {
    const e = makeEnv();
    startRace(e, ['a', 'b'], map.id);
    assert.equal(e.last('a', 'start').timeLimit, map.timeLimit);
    assert.equal(map.hitLimit, 3);
  }
});

test('queued players are not affected by other matches ending', () => {
  const e = makeEnv();
  startRanked(e);
  queueAll(e, ['c']);
  e.send('a', { type: 'fail', reason: 'bounds' });
  assert.deepEqual(e.lobby.queue, ['c']);
  assert.equal(e.msgs('c', 'results').length, 0);
});

test('duplicate token plays unscored', () => {
  const e = makeEnv();
  e.join('a', 'A', tok('a'));
  e.join('a2', 'A2', tok('a')); // same install connected twice
  assert.equal(e.lobby.players.get('a').token, tok('a'));
  assert.equal(e.lobby.players.get('a2').token, null);
  e.join('b', 'B', tok('b'));
  e.send('a2', { type: 'queue' });
  e.send('b', { type: 'queue' });
  e.advance(3000 + 5000);
  e.send('a2', { type: 'finish', time: 5, hits: 0 });
  const res = e.last('b', 'results');
  assert.deepEqual(res.standings.map((s) => [s.id, s.outcome, s.gained]), [['a2', 'win', 0], ['b', 'loss', 0]]);
  e.send('a', { type: 'leaderboard' });
  assert.deepEqual(e.last('a', 'leaderboard').entries.map((x) => [x.name, x.points, x.races]), [['B', 0, 1]]);
  // once the first connection is gone the token is free again
  e.lobby.disconnect('a');
  e.join('a3', 'A3', tok('a'));
  assert.equal(e.lobby.players.get('a3').token, tok('a'));
});
