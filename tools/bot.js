// Protocol-2 test bot. See README.md ("Bot") for options.
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? 'true' : process.argv[++i];
}
const url = args.url ?? 'ws://localhost:8787';
const name = args.name ?? 'Bot';
const mapId = args.map ?? 'central-reverse';
const startX = Number(args.x ?? -12), startY = Number(args.y ?? -6), startR = Number(args.r ?? 0);
const secs = (v) => (v === undefined || v === 'none' || v === 'true' ? null : Number(v) > 0 ? Number(v) : null);
// Scenario actions (seconds after `start`). With no action given the bot parks after 20 s, like before.
const hitsTarget = Math.max(0, Math.floor(Number(args.hits ?? 0)) || 0);
const hitEvery = secs(args['hit-every']) ?? 1;
const boundsAt = secs(args.bounds);
const leaveAt = secs(args.leave);
const anyAction = hitsTarget > 0 || boundsAt != null || leaveAt != null || args.park !== undefined;
const parkAt = args.park !== undefined ? secs(args.park) : anyAction ? null : secs(args.finish ?? 20);
const once = args.once === 'true';
const HZ = 15;

const ws = new WebSocket(url);
let timers = [];
let myId = null;
const quick = args.queue === 'true';
const token = args.token ?? `bot-${randomUUID()}`;
let wantCreate = !args.code && !quick;
let hits = 0;

const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
const stopRace = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; };
const after = (s, fn) => timers.push(setTimeout(fn, s * 1000));

// Unity convention: r = Rigidbody2D.rotation in degrees, counter-clockwise; r = 0 faces +y, forward = (-sin r, cos r).
function path(t) {
  // drive forward for 8 s at 2 u/s, then curve left (r increasing) with a constant turn rate
  const speed = 2;
  const straight = 8;
  const rad0 = (startR * Math.PI) / 180;
  if (t <= straight) {
    return { x: startX - Math.sin(rad0) * speed * t, y: startY + Math.cos(rad0) * speed * t, r: startR, s: speed };
  }
  const x0 = startX - Math.sin(rad0) * speed * straight;
  const y0 = startY + Math.cos(rad0) * speed * straight;
  const turn = 0.25; // rad/s
  const heading = rad0 + turn * (t - straight);
  const radius = speed / turn;
  // integral of (-sin h, cos h) dt with dh/dt = turn
  return {
    x: x0 + radius * (Math.cos(heading) - Math.cos(rad0)),
    y: y0 + radius * (Math.sin(heading) - Math.sin(rad0)),
    r: (heading * 180) / Math.PI,
    s: speed,
  };
}

function startRace() {
  const t0 = Date.now();
  hits = 0;
  const raceT = () => (Date.now() - t0) / 1000;
  // park progress p rises over the last 3 s before parking (0 when the bot never parks)
  const progress = (t) => (parkAt == null ? 0 : Math.min(1, Math.max(0, 1 - (parkAt - t) / 3)));
  timers.push(setInterval(() => { const t = raceT(); send({ type: 'pose', t, ...path(t), p: progress(t) }); }, 1000 / HZ));
  for (let i = 1; i <= hitsTarget; i++) {
    after(hitEvery * i, () => { hits = i; console.log(`hit ${i}`); send({ type: 'hit', hits: i }); });
  }
  if (boundsAt != null) after(boundsAt, () => { console.log('out of bounds'); send({ type: 'fail', reason: 'bounds' }); });
  if (parkAt != null) after(parkAt, () => { console.log('parked'); send({ type: 'finish', time: raceT(), hits }); });
  if (leaveAt != null) {
    after(leaveAt, () => {
      console.log('leaving the race');
      send({ type: 'leave' });
      stopRace();
      if (once) setTimeout(() => ws.close(), 200);
    });
  }
}

ws.on('open', () => {
  console.log(`connected to ${url}`);
  send({ type: 'hello', name, protocol: 2, token });
});
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  switch (m.type) {
    case 'welcome':
      myId = m.id;
      console.log(`WELCOME ${myId} points=${m.points}`);
      if (quick) { send({ type: 'queue' }); console.log('queued for a quick match'); }
      else if (wantCreate) send({ type: 'create', mapId });
      else send({ type: 'join', code: args.code });
      break;
    case 'room':
      if (wantCreate) { wantCreate = false; console.log(`ROOM CODE: ${m.code} (map ${m.mapId})`); }
      if (m.phase === 'lobby' && !m.ranked) {
        const me = m.players.find((p) => p.id === myId);
        // A private countdown needs both players ready; wait for the opponent before readying.
        if (me && !me.ready && m.players.length >= 2) send({ type: 'ready', ready: true });
      }
      break;
    case 'queued': console.log(`waiting: ${m.waiting} in queue`); break;
    case 'unqueued': console.log('left the queue'); break;
    case 'countdown': console.log(`countdown ${m.seconds}s on ${m.mapId}`); break;
    case 'start': console.log(`race ${m.raceId} started, limit ${m.timeLimit}s`); startRace(); break;
    case 'hit': console.log(`opponent ${m.id} hits ${m.hits}`); break;
    case 'results':
      stopRace();
      console.log(`RESULTS ${JSON.stringify({ me: myId, winnerId: m.winnerId, reason: m.reason, scored: m.scored, standings: m.standings })}`);
      if (once) { ws.close(); break; }
      if (quick) setTimeout(() => send({ type: 'queue' }), 2000); // keep playing matches
      break;
    case 'error': console.log(`server error: ${m.code} ${m.message}`); break;
  }
});
ws.on('close', () => { console.log('disconnected'); stopRace(); process.exit(0); });
ws.on('error', (e) => { console.log(`error: ${e.message}`); process.exit(1); });
