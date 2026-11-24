// Highlights short code in a tool row (a command, a read file, grep matches)
// with Pierre's shared Shiki highlighter and diff theme, so it matches the
// diffs beside it. Loaded with the first opened tool row, not with the app.

import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs';
import './diffLanguages';
import { DIFF_THEME } from './diffHighlighter';
import { hasBundledShikiLanguage } from './shikiLanguages';

export interface CodeToken {
  content: string;
  color?: string;
}

// Past this, highlighting would hold up the main thread; the text stays plain.
const MAX_CHARACTERS = 120_000;
const MARKUP = new Set(['vue', 'svelte', 'html', 'astro']);

export function languageForFile(name: string | undefined): string {
  if (!name) return 'text';
  const lang = getFiletypeFromFileName(name);
  return lang && hasBundledShikiLanguage(lang) ? lang : 'text';
}

// A single grep hit from a component file has no surrounding context. A line
// from its <script> block isn't markup, so it reads as TypeScript.
export function languageForLine(name: string | undefined, text: string): string {
  const lang = languageForFile(name);
  return MARKUP.has(lang) && !text.trimStart().startsWith('<') ? 'typescript' : lang;
}

// Tokens per line, or null when no language is bundled or the text is too
// long. A list of languages, one per line, highlights each line alone, for
// lines gathered from different places.
export async function highlightLines(lines: string[], lang: string | string[]): Promise<CodeToken[][] | null> {
  if (lines.reduce((total, line) => total + line.length, 0) > MAX_CHARACTERS) return null;
  const perLine = Array.isArray(lang);
  const langs = [...new Set(perLine ? lang : [lang])].filter((name) => name !== 'text' && hasBundledShikiLanguage(name));
  if (!langs.length) return null;
  const highlighter = await getSharedHighlighter({ themes: [DIFF_THEME], langs, preferredHighlighter: 'shiki-wasm' });
  const tokens = (code: string, name: string | undefined): CodeToken[][] => name && langs.includes(name)
    ? highlighter.codeToTokensBase(code, { lang: name, theme: DIFF_THEME }).map((line) => line.map((token) => ({ content: token.content, ...(token.color ? { color: token.color } : {}) })))
    : code.split('\n').map((line) => [{ content: line }]);
  if (perLine) return lines.map((line, index) => tokens(line, lang[index])[0] ?? [{ content: line }]);
  const result = tokens(lines.join('\n'), lang);
  return result.length === lines.length ? result : null;
}
