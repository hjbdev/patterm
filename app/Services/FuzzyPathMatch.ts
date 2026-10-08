// Fuzzy path matching for the @ file picker, modelled on fzf's v1 scorer.
// Query characters must appear in order. Matches score higher at path segment,
// word, and camelCase boundaries and when consecutive, and lose a little for
// each gap. A match inside the file name beats the same match spread across
// directories. Whitespace separates terms that must all match.

export interface PathMatch {
  score: number;
  // Indices into the path of each matched character, for highlighting.
  positions: number[];
}

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_SEGMENT = 10;
const BONUS_WORD = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 4;
const BONUS_NAME = 16;
const BONUS_NAME_PREFIX = 24;
const BONUS_NAME_EXACT = 48;

export function matchPath(path: string, query: string): PathMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, positions: [] };
  const lower = path.toLowerCase();
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const match = matchTerm(path, lower, term);
    if (!match) return null;
    score += match.score;
    for (const position of match.positions) positions.add(position);
  }
  return { score, positions: [...positions].sort((left, right) => left - right) };
}

function matchTerm(path: string, lower: string, term: string): PathMatch | null {
  const full = matchWindow(path, lower, term, 0);
  if (!full) return null;
  // A term with a separator targets directories, so only whole-path matching
  // applies to it.
  if (term.includes('/')) return full;
  // A directory path ends in `/`, and its name is the last segment.
  const nameEnd = path.endsWith('/') ? path.length - 1 : path.length;
  const nameStart = path.lastIndexOf('/', nameEnd - 1) + 1;
  const name = matchWindow(path, lower, term, nameStart);
  if (!name) return full;
  const lowerName = lower.slice(nameStart, nameEnd);
  const stem = lowerName.replace(/\.[^.]*$/, '');
  let score = name.score + BONUS_NAME;
  if (lowerName === term || stem === term) score += BONUS_NAME_EXACT;
  else if (lowerName.startsWith(term)) score += BONUS_NAME_PREFIX;
  return score >= full.score ? { score, positions: name.positions } : full;
}

// Finds the earliest end of an in-order match, then walks backwards to the
// tightest start before scoring that window.
function matchWindow(text: string, lower: string, term: string, from: number): PathMatch | null {
  let index = 0;
  let end = -1;
  for (let position = from; position < lower.length; position++) {
    if (lower[position] !== term[index]) continue;
    if (++index === term.length) {
      end = position;
      break;
    }
  }
  if (end < 0) return null;
  let start = end;
  index = term.length - 1;
  for (let position = end; position >= from; position--) {
    if (lower[position] !== term[index]) continue;
    start = position;
    if (--index < 0) break;
  }

  let score = 0;
  let consecutive = 0;
  let chunkBonus = 0;
  let inGap = false;
  const positions: number[] = [];
  index = 0;
  for (let position = start; position <= end; position++) {
    if (lower[position] !== term[index]) {
      score += inGap ? GAP_EXTENSION : GAP_START;
      inGap = true;
      consecutive = 0;
      continue;
    }
    let bonus = boundaryBonus(text, position, from);
    if (consecutive === 0) chunkBonus = bonus;
    else bonus = Math.max(bonus, chunkBonus, BONUS_CONSECUTIVE);
    score += SCORE_MATCH + (index === 0 ? bonus * 2 : bonus);
    positions.push(position);
    consecutive++;
    inGap = false;
    index++;
  }
  return { score, positions };
}

function boundaryBonus(text: string, position: number, from: number): number {
  if (position === from) return BONUS_SEGMENT;
  const previous = text[position - 1] ?? '';
  const current = text[position] ?? '';
  if (previous === '/') return BONUS_SEGMENT;
  if (previous === '-' || previous === '_' || previous === '.' || previous === ' ') return BONUS_WORD;
  if (isLower(previous) && isUpper(current)) return BONUS_CAMEL;
  if (!isDigit(previous) && isDigit(current)) return BONUS_CAMEL;
  return 0;
}

function isLower(character: string): boolean {
  return character >= 'a' && character <= 'z';
}

function isUpper(character: string): boolean {
  return character >= 'A' && character <= 'Z';
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}
