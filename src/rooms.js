import { MAPS, getMap } from './maps.js';
import { TOKEN_RE, createScoreStore } from './scores.js';

export const PROTOCOL = 2;
export const MAX_PLAYERS = 2;
export const COUNTDOWN_SECONDS = 3;
export const WIN_POINTS = 10;
export const FINISH_EARLY = 1.5;
export const FINISH_LATE = 0.25;
export const END_GRACE = 1.0;
export const MIN_FINISH_TIME = 3.0;
export const LEADERBOARD_SIZE = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Transport-free game logic (protocol 2: every match is exactly 2 players, first result event ends it).
 * deps: { now(): ms, setTimeout, clearTimeout, send(playerId, msg), random?, log?, scores?, timeLimitOverride? }
 * timeLimitOverride (seconds) replaces every map's timeLimit — test/e2e only.
 */
export function createLobby(deps) {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const sendRaw = deps.send;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  const scores = deps.scores ?? createScoreStore();
  const timeLimitOverride = isNum(deps.timeLimitOverride) && deps.timeLimitOverride > 0 ? deps.timeLimitOverride : null;

  const players = new Map(); // id -> { id, name|null, roomCode|null, token|null }
  const rooms = new Map(); // code -> room
  const queue = []; // matchmaking: player ids, oldest first
  let raceCounter = 0;

  const send = (id, msg) => {
    try { sendRaw(id, msg); } catch { /* transport errors are not game errors */ }
  };
  const err = (id, code, message) => send(id, { type: 'error', code, message });

  function newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
      if (!rooms.has(c)) return c;
    }
  }

  const members = (room) => [...room.members.values()];
  const publicPlayer = (m) => ({ id: m.id, name: m.name, color: m.color, ready: m.ready, status: m.status, time: m.time, hits: m.hits });

  function broadcast(room, msg, exceptId) {
    for (const m of room.members.values()) if (m.id !== exceptId) send(m.id, msg);
  }

  function broadcastRoom(room) {
    broadcast(room, {
      type: 'room',
      code: room.code,
      hostId: room.hostId,
      mapId: room.mapId,
      phase: room.phase,
      ranked: room.ranked,
      players: members(room).map(publicPlayer),
    });
  }

  function clearTimers(room) {
    if (room.countdownTimer != null) { clearT(room.countdownTimer); room.countdownTimer = null; }
    if (room.raceTimer != null) { clearT(room.raceTimer); room.raceTimer = null; }
  }

  function deleteRoom(room) {
    clearTimers(room);
    rooms.delete(room.code);
    for (const m of room.members.values()) { const p = players.get(m.id); if (p && p.roomCode === room.code) p.roomCode = null; }
    log(`room ${room.code} closed`);
  }

  function resetMember(m) {
    m.ready = false; m.status = 'lobby'; m.time = -1; m.hits = 0;
  }

  function newRoom(mapId, hostId, ranked) {
    const room = {
      code: newCode(), hostId, mapId, phase: 'lobby', members: new Map(), ranked,
      raceId: null, startedAt: 0, timeLimit: 0, hitLimit: 0, countdownTimer: null, raceTimer: null,
    };
    rooms.set(room.code, room);
    return room;
  }

  function addMember(room, p) {
    const used = new Set(members(room).map((m) => m.color));
    const color = used.has(0) ? 1 : 0;
    room.members.set(p.id, { id: p.id, name: p.name, token: p.token, color, ready: false, status: 'lobby', time: -1, hits: 0 });
    p.roomCode = room.code;
  }

  // ---- matchmaking: the two oldest queued players are paired at once; a lone player waits ----
  function queueStatus() {
    for (const id of queue) send(id, { type: 'queued', waiting: queue.length });
  }

  function updateQueue() {
    while (queue.length >= MAX_PLAYERS) formMatch(queue.splice(0, MAX_PLAYERS));
    queueStatus();
  }

  function removeFromQueue(id) {
    const i = queue.indexOf(id);
    if (i < 0) return false;
    queue.splice(i, 1);
    queueStatus();
    return true;
  }

  function randomMapId() {
    const ids = Object.keys(MAPS);
    return ids[Math.floor(random() * ids.length) % ids.length];
  }

  function formMatch(ids) {
    const room = newRoom(randomMapId(), ids[0], true);
    for (const id of ids) addMember(room, players.get(id));
    for (const m of room.members.values()) m.ready = true;
    log(`match ${room.code} formed: ${ids.join(',')} map=${room.mapId}`);
    beginCountdown(room);
  }

  // ---- countdown / race ----
  function maybeStartCountdown(room) {
    if (room.phase !== 'lobby' || room.members.size !== MAX_PLAYERS) return;
    if (!members(room).every((m) => m.ready)) return;
    beginCountdown(room);
  }

  // room before countdown, so a client that was not in a room yet already knows it when the countdown arrives
  function beginCountdown(room) {
    room.phase = 'countdown';
    room.raceId = ++raceCounter;
    room.countdownTimer = setT(() => { room.countdownTimer = null; startRace(room); }, COUNTDOWN_SECONDS * 1000);
    log(`room ${room.code} countdown ${room.raceId} map=${room.mapId}`);
    broadcastRoom(room);
    broadcast(room, { type: 'countdown', raceId: room.raceId, mapId: room.mapId, seconds: COUNTDOWN_SECONDS });
  }

  function cancelCountdown(room, resetReady) {
    if (room.phase !== 'countdown') return;
    if (room.countdownTimer != null) { clearT(room.countdownTimer); room.countdownTimer = null; }
    room.phase = 'lobby';
    if (resetReady) for (const m of room.members.values()) m.ready = false;
    log(`room ${room.code} countdown cancelled`);
  }

  function startRace(room) {
    if (room.phase !== 'countdown') return;
    const map = getMap(room.mapId);
    room.phase = 'racing';
    room.startedAt = now();
    room.timeLimit = timeLimitOverride ?? map.timeLimit;
    room.hitLimit = map.hitLimit;
    for (const m of room.members.values()) { m.status = 'racing'; m.time = -1; m.hits = 0; }
    broadcast(room, { type: 'start', raceId: room.raceId, mapId: room.mapId, timeLimit: room.timeLimit });
    room.raceTimer = setT(() => { room.raceTimer = null; endMatch(room, '', 'time', []); }, (room.timeLimit + END_GRACE) * 1000);
    log(`room ${room.code} race ${room.raceId} started`);
    broadcastRoom(room);
  }

  const elapsed = (room) => (now() - room.startedAt) / 1000;

  /**
   * Ends the match at once for both players. winnerId '' = draw.
   * departed: members already removed from the room (leaver) who still appear in the standings.
   */
  function endMatch(room, winnerId, reason, departed) {
    if (room.phase !== 'racing' && room.phase !== 'countdown') return;
    clearTimers(room);
    const entrants = [...members(room), ...departed];
    for (const e of entrants) {
      if (!(reason === 'parked' && e.id === winnerId)) { e.status = 'dnf'; e.time = -1; }
    }
    const outcomeOf = (e) => (!winnerId ? 'draw' : e.id === winnerId ? 'win' : 'loss');
    const scored = room.ranked;
    const gainedOf = (e) => (scored && e.token && outcomeOf(e) === 'win' ? WIN_POINTS : 0);
    if (scored) {
      scores.recordRace(entrants.map((e) => ({ token: e.token, name: e.name, gained: gainedOf(e), won: outcomeOf(e) === 'win' })));
    }
    const standings = entrants
      .map((e) => {
        const outcome = outcomeOf(e);
        return {
          id: e.id, name: e.name, color: e.color, place: outcome === 'loss' ? 2 : 1, outcome,
          status: e.status, time: e.time, hits: e.hits, gained: gainedOf(e), total: scores.stats(e.token).points,
        };
      })
      .sort((a, b) => a.place - b.place || a.color - b.color);
    broadcast(room, { type: 'results', raceId: room.raceId, mapId: room.mapId, ranked: room.ranked, scored, winnerId, reason, standings });
    log(`room ${room.code} race ${room.raceId} results: ${reason} winner=${winnerId || '(draw)'}${scored ? ' (scored)' : ''}`);
    if (room.ranked) {
      // A ranked match is one race; everyone goes back to the menu and can queue again.
      deleteRoom(room);
      return;
    }
    room.phase = 'lobby';
    for (const m of room.members.values()) resetMember(m);
    broadcastRoom(room);
  }

  const opponentOf = (room, id) => members(room).find((m) => m.id !== id);

  // ---- membership ----
  function leaveRoom(playerId) {
    const p = players.get(playerId);
    if (!p || !p.roomCode) return false;
    const room = rooms.get(p.roomCode);
    p.roomCode = null;
    if (!room) return true;
    const m = room.members.get(playerId);
    room.members.delete(playerId);
    log(`room ${room.code} player ${playerId} left`);
    if (room.members.size === 0) { deleteRoom(room); return true; }
    if (room.hostId === playerId) room.hostId = room.members.keys().next().value;
    // Forfeit: ranked from room creation (countdown included), private only once racing.
    const forfeit = m && (room.phase === 'racing' || (room.ranked && room.phase === 'countdown'));
    if (forfeit) {
      endMatch(room, opponentOf(room, playerId).id, 'left', [m]);
      return true;
    }
    // A private countdown is simply cancelled; the room waits in the lobby for a new opponent.
    cancelCountdown(room, true);
    broadcastRoom(room);
    return true;
  }

  // ---- handlers ----
  // finish/hit/fail/pose outside an active race are ignored silently (they often arrive just after the end).
  function activeRacer(p) {
    const room = roomOf(p);
    if (!room || room.phase !== 'racing') return null;
    const m = room.members.get(p.id);
    return m && m.status === 'racing' ? { room, m } : null;
  }

  const handlers = {
    create(p, msg) {
      if (p.roomCode) return err(p.id, 'already_in_room', 'Zaten bir odadasın.');
      if (queue.includes(p.id)) return err(p.id, 'in_queue', 'Eşleşme sırasındasın.');
      if (!getMap(msg.mapId)) return err(p.id, 'unknown_map', 'Bilinmeyen harita.');
      const room = newRoom(msg.mapId, p.id, false);
      addMember(room, p);
      log(`room ${room.code} created by ${p.id} map=${room.mapId}`);
      broadcastRoom(room);
    },
    join(p, msg) {
      if (p.roomCode) return err(p.id, 'already_in_room', 'Zaten bir odadasın.');
      if (queue.includes(p.id)) return err(p.id, 'in_queue', 'Eşleşme sırasındasın.');
      if (typeof msg.code !== 'string') return err(p.id, 'bad_request', 'Geçersiz oda kodu.');
      const code = msg.code.trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return err(p.id, 'room_not_found', 'Oda bulunamadı.');
      if (room.ranked) return err(p.id, 'ranked_room', 'Bu oda hızlı maça ait; koduyla girilemez.');
      if (room.members.size >= MAX_PLAYERS) return err(p.id, 'room_full', 'Oda dolu.');
      if (room.phase !== 'lobby') return err(p.id, 'race_in_progress', 'Yarış başladı, odaya girilemez.');
      addMember(room, p);
      log(`room ${room.code} player ${p.id} joined`);
      broadcastRoom(room);
    },
    leave(p) {
      if (!p.roomCode) return err(p.id, 'not_in_room', 'Bir odada değilsin.');
      leaveRoom(p.id);
    },
    setMap(p, msg) {
      const room = roomOf(p);
      if (!room) return err(p.id, 'not_in_room', 'Bir odada değilsin.');
      if (room.ranked) return err(p.id, 'ranked_room', 'Hızlı maçta harita rastgele seçilir.');
      if (room.hostId !== p.id) return err(p.id, 'not_host', 'Sadece oda sahibi harita seçebilir.');
      if (room.phase !== 'lobby') return err(p.id, 'not_lobby', 'Harita sadece lobide değiştirilebilir.');
      if (!getMap(msg.mapId)) return err(p.id, 'unknown_map', 'Bilinmeyen harita.');
      room.mapId = msg.mapId;
      for (const m of room.members.values()) m.ready = false;
      broadcastRoom(room);
    },
    ready(p, msg) {
      const room = roomOf(p);
      if (!room) return err(p.id, 'not_in_room', 'Bir odada değilsin.');
      if (typeof msg.ready !== 'boolean') return err(p.id, 'bad_request', 'Geçersiz istek.');
      if (room.ranked) return err(p.id, 'ranked_room', 'Hızlı maç kendiliğinden başlar.');
      if (room.phase === 'racing') return err(p.id, 'not_lobby', 'Yarış sürüyor.');
      const m = room.members.get(p.id);
      if (room.phase === 'countdown') {
        if (msg.ready) return;
        m.ready = false;
        cancelCountdown(room, false);
        return broadcastRoom(room);
      }
      m.ready = msg.ready;
      broadcastRoom(room);
      maybeStartCountdown(room);
    },
    pose(p, msg) {
      const a = activeRacer(p);
      if (!a) return;
      if (!isNum(msg.t) || !isNum(msg.x) || !isNum(msg.y) || !isNum(msg.r) || !isNum(msg.s)) {
        return err(p.id, 'bad_request', 'Geçersiz konum verisi.');
      }
      const prog = isNum(msg.p) ? Math.min(1, Math.max(0, msg.p)) : 0;
      broadcast(a.room, { type: 'pose', id: p.id, t: msg.t, x: msg.x, y: msg.y, r: msg.r, s: msg.s, p: prog }, p.id);
    },
    hit(p, msg) {
      const a = activeRacer(p);
      if (!a) return;
      if (!Number.isInteger(msg.hits) || msg.hits < 1) return err(p.id, 'bad_request', 'Geçersiz çarpma verisi.');
      const { room, m } = a;
      const hits = Math.min(msg.hits, room.hitLimit);
      if (hits <= m.hits) return; // stale / repeated value
      m.hits = hits;
      broadcast(room, { type: 'hit', id: p.id, hits }, p.id);
      if (hits >= room.hitLimit) endMatch(room, opponentOf(room, p.id).id, 'hits', []);
    },
    finish(p, msg) {
      const a = activeRacer(p);
      if (!a) return;
      if (!isNum(msg.time) || !Number.isInteger(msg.hits) || msg.hits < 0 || msg.hits > 1000) {
        return err(p.id, 'bad_request', 'Geçersiz bitiş verisi.');
      }
      const { room, m } = a;
      const el = elapsed(room);
      const time = Math.max(0, Math.min(Math.max(msg.time, el - FINISH_EARLY), el + FINISH_LATE));
      const hits = Math.max(m.hits, msg.hits);
      if (hits >= room.hitLimit || el > room.timeLimit + END_GRACE || time < MIN_FINISH_TIME) {
        return err(p.id, 'finish_rejected', 'Park kabul edilmedi.');
      }
      m.status = 'finished'; m.time = time; m.hits = hits;
      endMatch(room, p.id, 'parked', []);
    },
    fail(p, msg) {
      const a = activeRacer(p);
      if (!a) return;
      if (msg.reason !== 'bounds') return err(p.id, 'bad_request', 'Geçersiz istek.');
      endMatch(a.room, opponentOf(a.room, p.id).id, 'bounds', []);
    },
    queue(p) {
      if (p.roomCode) return err(p.id, 'already_in_room', 'Zaten bir odadasın.');
      if (queue.includes(p.id)) return queueStatus();
      queue.push(p.id);
      log(`player ${p.id} queued (${queue.length} waiting)`);
      updateQueue();
    },
    unqueue(p) {
      if (!removeFromQueue(p.id)) return err(p.id, 'not_in_queue', 'Eşleşme sırasında değilsin.');
      send(p.id, { type: 'unqueued' });
    },
    leaderboard(p) {
      send(p.id, { type: 'leaderboard', entries: scores.top(LEADERBOARD_SIZE) });
    },
  };

  function roomOf(p) { return p.roomCode ? rooms.get(p.roomCode) : null; }

  return {
    rooms,
    players,
    queue,
    connect(id) {
      players.set(id, { id, name: null, roomCode: null, token: null });
    },
    message(id, msg) {
      const p = players.get(id);
      if (!p) return;
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return err(id, 'bad_request', 'Geçersiz mesaj.');
      }
      if (msg.type === 'hello') {
        if (p.name) return err(id, 'already_hello', 'Zaten tanıştık.');
        const name = typeof msg.name === 'string' ? msg.name.trim() : '';
        if (name.length < 1 || name.length > 16) return err(id, 'bad_name', 'İsim 1-16 karakter olmalı.');
        if (/[<>]/.test(name)) return err(id, 'bad_name', 'İsim < veya > içeremez.');
        if (msg.protocol !== PROTOCOL) return err(id, 'bad_protocol', 'Desteklenmeyen protokol sürümü. Oyunu güncelle.');
        p.name = name;
        // Optional private token keeps points across sessions; a missing or malformed one just plays unscored.
        p.token = typeof msg.token === 'string' && TOKEN_RE.test(msg.token) ? msg.token : null;
        // The same token on two live connections would let one install score twice: the newcomer plays unscored.
        if (p.token && [...players.values()].some((o) => o !== p && o.token === p.token)) {
          log(`player ${id} token already connected, playing unscored`);
          p.token = null;
        }
        scores.rename(p.token, name);
        log(`player ${id} hello "${name}"${p.token ? '' : ' (no token)'}`);
        return send(id, { type: 'welcome', id, protocol: PROTOCOL, ...scores.stats(p.token) });
      }
      if (!p.name) return err(id, 'hello_required', 'Önce hello göndermelisin.');
      const h = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
      if (!h) return err(id, 'unknown_type', 'Bilinmeyen mesaj tipi.');
      h(p, msg);
    },
    disconnect(id) {
      removeFromQueue(id);
      leaveRoom(id);
      players.delete(id);
    },
  };
}
