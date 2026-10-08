// Retained solely for the historical identifier migration.
export function availableProjectKey(name: string, usedKeys: ReadonlySet<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  const padded = `${letters}XXX`;
  const candidates = new Set<string>([padded.slice(0, 3)]);

  for (const letter of `${letters.slice(2)}ABCDEFGHIJKLMNOPQRSTUVWXYZ`) candidates.add(`${padded.slice(0, 2)}${letter}`);
  for (const second of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const third of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') candidates.add(`${padded[0]}${second}${third}`);
  }
  for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const second of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const third of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') candidates.add(`${first}${second}${third}`);
    }
  }

  for (const candidate of candidates) {
    if (!usedKeys.has(candidate)) return candidate;
  }
  throw new Error('no project keys are available');
}
