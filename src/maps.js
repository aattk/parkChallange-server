// Shared map list: same ids, order and limits as Unity Assets/_Game/Runtime/Maps/RaceMapIds.cs (docs/OYUN_PLANI.md §4.4).
const map = (id, timeLimit) => Object.freeze({ id, timeLimit, hitLimit: 3 });

export const MAPS = Object.freeze({
  'central-reverse': map('central-reverse', 90),
  'pillar-garage': map('pillar-garage', 120),
  'parallel-street': map('parallel-street', 120),
  'angled-row': map('angled-row', 75),
  'tight-garage': map('tight-garage', 90),
  'cone-slalom': map('cone-slalom', 100),
  'narrow-alley': map('narrow-alley', 110),
  'diagonal-plaza': map('diagonal-plaza', 90),
  'uturn-bay': map('uturn-bay', 100),
  'double-parked': map('double-parked', 120),
});

export function getMap(id) {
  return typeof id === 'string' && Object.hasOwn(MAPS, id) ? MAPS[id] : null;
}
