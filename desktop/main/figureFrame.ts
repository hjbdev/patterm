import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, protocol, session, shell, type WebContents } from 'electron';
import type { PagePreview, PagePreviewer } from '../../app/Actions/PreviewHtmlFigureAction';
import { FIGURE_FRAME_HTML, FIGURE_FRAME_SCHEME, figureFontCss, figureFontFile, figureFrameCsp } from '../../app/Services/HtmlFigure';

const FRAME_URL = `${FIGURE_FRAME_SCHEME}://figure/`;
const PREVIEW_PARTITION = 'patterm-figure-preview';
const MAX_CAPTURE_HEIGHT = 4000;
const LOAD_TIMEOUT_MS = 15_000;
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

// A figure frame may not navigate itself away; its links go to the browser.
export function guardFigureFrames(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !event.frame?.url.startsWith(`${FIGURE_FRAME_SCHEME}:`) || event.url.startsWith(`${FIGURE_FRAME_SCHEME}:`)) return;
    event.preventDefault();
    if (event.url.startsWith('http://') || event.url.startsWith('https://')) void shell.openExternal(event.url);
  });
}

// Draws a page in a hidden window, in its own session, the way the reply
// column would, then screenshots it.
export class ElectronPagePreviewer implements PagePreviewer {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private fonts: string | null = null;

  // fontDirectory holds Inter's faces: the build's figure-fonts, or the
  // vendored fonts in a development checkout.
  constructor(private readonly fontDirectory: string) {}

  fontCss(): string {
    this.fonts ??= figureFontCss((subset, weight) => {
      try {
        return `data:font/woff2;base64,${fs.readFileSync(path.join(this.fontDirectory, figureFontFile(subset, weight))).toString('base64')}`;
      } catch {
        return null;
      }
    });
    return this.fonts;
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
      await window.loadURL(FRAME_URL);
      await window.webContents.executeJavaScript(`window.postMessage({ source: 'patterm-host', type: 'render', html: ${JSON.stringify(html)} }, '*'); undefined`);
      await until(() => window.webContents.executeJavaScript(`document.readyState === 'complete' && Boolean(document.getElementById('patterm-theme'))`) as Promise<boolean>, LOAD_TIMEOUT_MS);
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      // First animation frames and chart libraries settle.
      await delay(500);
      const contentHeight = await window.webContents.executeJavaScript('Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0))') as number;
      const capturedHeight = Math.min(MAX_CAPTURE_HEIGHT, Math.max(1, contentHeight));
      window.setContentSize(width, capturedHeight);
      await delay(200);
      const image = await window.webContents.capturePage({ x: 0, y: 0, width, height: capturedHeight });
      return { width, contentHeight, capturedHeight, png: image.toPNG(), consoleMessages };
    } finally {
      window.destroy();
      this.release();
    }
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

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`html_preview: the page did not finish loading within ${timeoutMs / 1000} s`);
    await delay(100);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
