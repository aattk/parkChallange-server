import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;
const EMPTY = Object.freeze({ points: 0, wins: 0, races: 0 });

/**
 * Persistent per-player score table keyed by the client's private token.
 * file: JSON path, or null for memory-only (tests).
 */
export function createScoreStore({ file = null, log = () => {} } = {}) {
  const table = new Map(); // token -> { name, points, wins, races }

  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [token, e] of Object.entries(saved.players ?? {})) {
        if (!TOKEN_RE.test(token) || e === null || typeof e !== 'object') continue;
        table.set(token, {
          name: typeof e.name === 'string' ? e.name : '?',
          points: Number.isInteger(e.points) ? e.points : 0,
          wins: Number.isInteger(e.wins) ? e.wins : 0,
          races: Number.isInteger(e.races) ? e.races : 0,
        });
      }
      log(`scores loaded: ${table.size} players from ${file}`);
    } catch (e) {
      log(`scores file unreadable, starting empty: ${e.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ players: Object.fromEntries(table) }, null, 1));
      fs.renameSync(tmp, file);
    } catch (e) {
      log(`scores save failed: ${e.message}`);
    }
  }

  const stats = (token) => {
    const e = token ? table.get(token) : null;
    return e ? { points: e.points, wins: e.wins, races: e.races } : { ...EMPTY };
  };

  return {
    stats,
    /** keeps the stored display name current; does not create an entry */
    rename(token, name) {
      const e = token ? table.get(token) : null;
      if (e && e.name !== name) { e.name = name; save(); }
    },
    /** entries: [{ token, name, gained, won }]; entries without a token are skipped. Saves once. */
    recordRace(entries) {
      for (const { token, name, gained, won } of entries) {
        if (!token) continue;
        const e = table.get(token) ?? { name, points: 0, wins: 0, races: 0 };
        e.name = name; e.points += gained; e.races += 1; if (won) e.wins += 1;
        table.set(token, e);
      }
      save();
    },
    top(n) {
      return [...table.values()]
        .filter((e) => e.races > 0)
        .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name))
        .slice(0, n)
        .map((e) => ({ name: e.name, points: e.points, wins: e.wins, races: e.races }));
    },
  };
}
