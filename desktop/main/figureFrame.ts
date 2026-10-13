import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, protocol, session, type WebContents } from 'electron';
import type { PagePreview, PagePreviewer } from '../../app/Actions/PreviewHtmlFigureAction';
import type { FontSettings } from '../../app/Services/FontFamilies';
import { FIGURE_FRAME_HTML, FIGURE_FRAME_SCHEME, figureFontStyle, figureFrameCsp } from '../../app/Services/HtmlFigure';

const FRAME_URL = `${FIGURE_FRAME_SCHEME}://figure/`;
const PREVIEW_PARTITION = 'patterm-figure-preview';
const MAX_CAPTURE_HEIGHT = 4000;
const CAPTURE_TIMEOUT_MS = 20_000;
const MAX_CONSOLE_MESSAGES = 20;
const MAX_PREVIEWS = 2;

// Agent pages need their own policy, which a file:// renderer cannot give a
// child frame, so they load from this scheme. Call before the app is ready.
export function registerFigureFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FIGURE_FRAME_SCHEME, privileges: { standard: true, secure: true } }]);
}

export function serveFigureFrames(): void {
  for (const target of [session.defaultSession, session.fromPartition(PREVIEW_PARTITION)]) {
    target.protocol.handle(FIGURE_FRAME_SCHEME, () => new Response(FIGURE_FRAME_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': figureFrameCsp(null), 'Cache-Control': 'no-store' }
    }));
  }
}

// A figure frame may not navigate itself away. Its links open as popups,
// which the window's open handler sends to the browser after a click.
export function guardFigureFrames(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !event.frame?.url.startsWith(`${FIGURE_FRAME_SCHEME}:`) || event.url.startsWith(`${FIGURE_FRAME_SCHEME}:`)) return;
    event.preventDefault();
  });
}

// Draws a page in a hidden window, in its own session, the way the reply
// column would, then screenshots it.
export class ElectronPagePreviewer implements PagePreviewer {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly faces = new Map<string, string | null>();

  // fontDirectory holds the bundled faces: the build's figure-fonts, or the
  // vendored fonts in a development checkout. fontSettings gives the user's
  // current typefaces.
  constructor(private readonly fontDirectory: string, private readonly fontSettings: () => FontSettings) {}

  fontCss(): string {
    return figureFontStyle(this.fontSettings(), (file) => {
      if (!this.faces.has(file)) {
        try {
          this.faces.set(file, `data:font/woff2;base64,${fs.readFileSync(path.join(this.fontDirectory, file)).toString('base64')}`);
        } catch {
          this.faces.set(file, null);
        }
      }
      return this.faces.get(file)!;
    });
  }

  async capture(html: string, width: number): Promise<PagePreview> {
    await this.acquire();
    const window = new BrowserWindow({
      show: false,
      width,
      height: 800,
      useContentSize: true,
      backgroundColor: '#151515',
      webPreferences: { offscreen: true, partition: PREVIEW_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    const consoleMessages: PagePreview['consoleMessages'] = [];
    window.webContents.on('console-message', (details) => {
      if (consoleMessages.length < MAX_CONSOLE_MESSAGES) consoleMessages.push({ level: details.level, text: details.message.slice(0, 500) });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    try {
      // One deadline for the whole capture: a page that never finishes a
      // script would otherwise hold its slot and window for good.
      return await deadline(this.draw(window, html, width, consoleMessages), CAPTURE_TIMEOUT_MS);
    } finally {
      window.destroy();
      this.release();
    }
  }

  private async draw(window: BrowserWindow, html: string, width: number, consoleMessages: PagePreview['consoleMessages']): Promise<PagePreview> {
    await window.loadURL(FRAME_URL);
    await window.webContents.executeJavaScript(`window.postMessage({ source: 'patterm-host', type: 'render', html: ${JSON.stringify(html)} }, '*'); undefined`);
    while (!await window.webContents.executeJavaScript(`document.readyState === 'complete' && Boolean(document.getElementById('patterm-theme'))`)) await delay(100);
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    // First animation frames and chart libraries settle.
    await delay(500);
    const contentHeight = await window.webContents.executeJavaScript('Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0))') as number;
    const capturedHeight = Math.min(MAX_CAPTURE_HEIGHT, Math.max(1, contentHeight));
    window.setContentSize(width, capturedHeight);
    await delay(200);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height: capturedHeight });
    return { width, contentHeight, capturedHeight, png: image.toPNG(), consoleMessages };
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_PREVIEWS) { this.running++; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`html_preview: the page did not finish drawing within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
