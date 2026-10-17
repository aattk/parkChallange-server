// End-to-end check: real server on a random free port + two tools/bot.js processes per scenario.
// Prints `E2E_PASSED: parked, hits, bounds, left, time` and exits 0, or prints the failure and exits 1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TIME_LIMIT = 6; // RACE_TIME_LIMIT_OVERRIDE for this run, keeps the `time` scenario short
const STEP_TIMEOUT_MS = 30_000;

// winner: which bot must win ('A', 'B' or '' for a draw). Bot A always queues first.
const SCENARIOS = [
  { name: 'parked', a: ['--park', '4'], b: ['--park', 'none'], winner: 'A', reason: 'parked' },
  { name: 'hits', a: ['--park', 'none', '--hits', '3', '--hit-every', '0.7'], b: ['--park', 'none'], winner: 'B', reason: 'hits' },
  { name: 'bounds', a: ['--park', 'none', '--bounds', '2'], b: ['--park', 'none'], winner: 'B', reason: 'bounds' },
  { name: 'left', a: ['--park', 'none', '--leave', '2'], b: ['--park', 'none'], winner: 'B', reason: 'left' },
  { name: 'time', a: ['--park', 'none'], b: ['--park', 'none'], winner: '', reason: 'time' },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function run(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = { child, out: '', exited: null };
  child.stdout.on('data', (d) => { proc.out += d; });
  child.stderr.on('data', (d) => { proc.out += d; });
  proc.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return proc;
}

async function waitFor(proc, text, label) {
  const until = Date.now() + STEP_TIMEOUT_MS;
  while (!proc.out.includes(text)) {
    if (Date.now() > until) throw new Error(`${label}: timed out waiting for "${text}"\n${proc.out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function withTimeout(promise, label, out) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label}: timed out\n${out()}`)), STEP_TIMEOUT_MS); }),
  ]);
}

const resultsOf = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('RESULTS ')).map((l) => JSON.parse(l.slice(8)));

async function scenario(url, sc) {
  const botA = run(['tools/bot.js', '--url', url, '--queue', '--once', '--name', `A-${sc.name}`, ...sc.a]);
  await waitFor(botA, 'queued for a quick match', `${sc.name}/A`);
  const botB = run(['tools/bot.js', '--url', url, '--queue', '--once', '--name', `B-${sc.name}`, ...sc.b]);
  const outs = () => `--- A ---\n${botA.out}\n--- B ---\n${botB.out}`;
  await withTimeout(Promise.all([botA.exited, botB.exited]), sc.name, outs);

  // The bot that sent `leave` gets no results; every other bot must get exactly one.
  const expectA = sc.reason === 'left' ? 0 : 1;
  const resA = resultsOf(botA.out), resB = resultsOf(botB.out);
  if (resA.length !== expectA || resB.length !== 1) throw new Error(`${sc.name}: expected ${expectA}/1 results, got ${resA.length}/${resB.length}\n${outs()}`);
  for (const res of [...resA, ...resB]) {
    const idOf = (prefix) => res.standings.find((s) => s.name === `${prefix}-${sc.name}`)?.id;
    const wantWinner = sc.winner ? idOf(sc.winner) : '';
    if (res.reason !== sc.reason || res.winnerId !== wantWinner || !res.scored) {
      throw new Error(`${sc.name}: got winnerId=${res.winnerId} reason=${res.reason} scored=${res.scored}, want winnerId=${wantWinner} reason=${sc.reason}\n${outs()}`);
    }
    const outcomes = res.standings.map((s) => s.outcome).sort().join(',');
    const wantOutcomes = sc.winner ? 'loss,win' : 'draw,draw';
    if (outcomes !== wantOutcomes) throw new Error(`${sc.name}: outcomes ${outcomes}, want ${wantOutcomes}`);
    const gained = res.standings.reduce((n, s) => n + s.gained, 0);
    if (gained !== (sc.winner ? 10 : 0)) throw new Error(`${sc.name}: gained ${gained} points in total`);
  }
  console.log(`ok ${sc.name}: winner=${sc.winner || '(draw)'} reason=${sc.reason}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-e2e-'));
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const server = run(['src/index.js'], { PORT: String(port), SCORES_FILE: path.join(dir, 'scores.json'), RACE_TIME_LIMIT_OVERRIDE: String(TIME_LIMIT) });
  let failed = false;
  try {
    await waitFor(server, 'listening on port', 'server');
    for (const sc of SCENARIOS) await scenario(url, sc);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scores.json'), 'utf8'));
    if (Object.keys(saved.players).length !== 10) throw new Error(`scores.json has ${Object.keys(saved.players).length} players, want 10`);
    console.log(`E2E_PASSED: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  } catch (e) {
    failed = true;
    console.error(`E2E_FAILED: ${e.message}`);
    console.error(`--- server log ---\n${server.out}`);
  } finally {
    server.child.kill();
    await server.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main();
