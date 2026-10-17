import { createLobby } from '../src/rooms.js';

export function makeEnv(extra = {}) {
  let t = 1_000_000;
  let nextTimer = 1;
  const timers = new Map();
  const inbox = new Map();
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const lobby = createLobby({ ...clock, ...extra, send: (id, msg) => { if (!inbox.has(id)) inbox.set(id, []); inbox.get(id).push(msg); } });
  const advance = (ms) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = target;
  };
  const msgs = (id, type) => (inbox.get(id) ?? []).filter((m) => !type || m.type === type);
  const last = (id, type) => msgs(id, type).at(-1);
  const clear = () => inbox.clear();
  const join = (id, name = id, token) => {
    lobby.connect(id);
    lobby.message(id, { type: 'hello', name, protocol: 2, ...(token ? { token } : {}) });
  };
  const send = (id, msg) => lobby.message(id, msg);
  return { lobby, advance, msgs, last, clear, join, send, timers };
}

export const tok = (id) => `token-${id}-0000`;

/** private room with the given player ids; first is host. returns room code */
export function setupRoom(env, ids, mapId = 'central-reverse') {
  env.join(ids[0], ids[0], tok(ids[0]));
  env.send(ids[0], { type: 'create', mapId });
  const code = env.last(ids[0], 'room').code;
  for (const id of ids.slice(1)) { env.join(id, id, tok(id)); env.send(id, { type: 'join', code }); }
  return code;
}

/** private 2-player race, racing after this returns */
export function startRace(env, ids = ['a', 'b'], mapId) {
  const code = setupRoom(env, ids, mapId);
  for (const id of ids) env.send(id, { type: 'ready', ready: true });
  env.advance(3000);
  return code;
}

/** queue players (with tokens unless withTokens=false) */
export function queueAll(env, ids, withTokens = true) {
  for (const id of ids) { env.join(id, id.toUpperCase(), withTokens ? tok(id) : undefined); env.send(id, { type: 'queue' }); }
}

/** ranked 2-player race, racing after this returns */
export function startRanked(env, ids = ['a', 'b'], withTokens = true) {
  queueAll(env, ids, withTokens);
  env.advance(3000);
  return env.last(ids[0], 'start');
}
