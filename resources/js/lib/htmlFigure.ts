// Wiring for HTML figures: where their frame loads from, and the answer
// channel between the conversation and its pages. Components stay
// presentational; pages themselves run in the sandboxed frame.

import type { ComputedRef, InjectionKey } from 'vue';
import { FIGURE_FRAME_PATH, FIGURE_FRAME_SCHEME } from '../../../app/Services/HtmlFigure';
import type { TranscriptMessage } from '../../../app/Services/TranscriptProjection';
import { transcriptImageData } from './transcriptImages';

// Sending answers belongs to the live conversation. History and other
// read-only transcripts provide nothing, so pages there cannot answer.
export interface FigureAnswerChannel {
  canSend: ComputedRef<boolean>;
  send: (text: string) => Promise<void> | void;
  // Answers waiting in the agent's queue, which the transcript leaves out
  // until they are delivered.
  queued: ComputedRef<Map<string, string>>;
}
export const figureAnswerKey: InjectionKey<FigureAnswerChannel> = Symbol('figureAnswer');
export const figureAnsweredKey: InjectionKey<ComputedRef<Map<string, string>>> = Symbol('figureAnswered');
// Pages a transcript can place inline, by id.
export const figuresKey: InjectionKey<ComputedRef<Map<string, TranscriptMessage>>> = Symbol('figures');

// The browser server serves the frame itself; the desktop app answers its
// own scheme, since a file:// page cannot give a child frame its own policy.
export function figureFrameUrl(): string {
  return window.patterm.runtime === 'browser' ? FIGURE_FRAME_PATH : `${FIGURE_FRAME_SCHEME}://figure/`;
}

// A page's stored local images as data URLs; the frame cannot read anything
// from Patterm, so each image travels inside the page.
export async function figureImageUrls(images: Record<string, string>): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  await Promise.all(Object.entries(images).map(async ([requested, sha256]) => {
    try {
      const image = await transcriptImageData(sha256);
      urls.set(requested, `data:${image.mime};base64,${image.data}`);
    } catch {
      // A pruned image stays a broken image in the page.
    }
  }));
  return urls;
}

// Inter for pages, loaded once with the first page shown.
let fonts: Promise<string> | null = null;
export function figureFontCss(): Promise<string> {
  fonts ??= import('./figureFonts').then((module) => module.FIGURE_FONT_CSS, () => { fonts = null; return ''; });
  return fonts;
}
