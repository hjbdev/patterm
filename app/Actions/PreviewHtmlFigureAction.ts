import { formatInputErrors, htmlPreviewInput, PREVIEW_WIDTH, prepareFigureHtml, replaceFigureImages } from '../Services/HtmlFigure';
import type { TranscriptImageStore } from '../Services/TranscriptImageStore';
import { storeImages, storeVideos, type FigureCaller, type FigureVideos } from './RenderHtmlFigureAction';

export interface PagePreview {
  width: number;
  contentHeight: number;
  capturedHeight: number;
  png: Buffer;
  consoleMessages: Array<{ level: string; text: string }>;
}

// Draws a prepared page off screen. Only the desktop app has one.
export interface PagePreviewer {
  capture(html: string, width: number): Promise<PagePreview>;
  // @font-face rules for the faces pages get, as in the reply column.
  fontCss?(): string;
}

// Shows the agent its page as the user would see it, before it renders it.
// Nothing is kept and the user never sees it.
export class PreviewHtmlFigureAction {
  constructor(
    private readonly previewer: PagePreviewer,
    private readonly images: Pick<TranscriptImageStore, 'fromFile' | 'read'> | undefined,
    private readonly videos?: FigureVideos | undefined
  ) {}

  async execute(raw: unknown, caller: FigureCaller) {
    const parsed = htmlPreviewInput.safeParse(raw);
    if (!parsed.success) throw new Error(`html_preview: ${formatInputErrors(parsed.error).join('; ')}`);
    const { images, errors } = storeImages(this.images, parsed.data.html, caller);
    // Videos are checked and stored as html_render would, but not drawn.
    const played = await storeVideos(this.videos, parsed.data.html, caller);
    const urls = new Map<string, string>();
    for (const [requested, sha256] of Object.entries(images)) {
      const stored = this.images?.read(sha256);
      if (stored) urls.set(requested, `data:${stored.mime};base64,${stored.data}`);
    }
    const width = parsed.data.width ?? PREVIEW_WIDTH.initial;
    const preview = await this.previewer.capture(prepareFigureHtml(replaceFigureImages(parsed.data.html, urls), this.previewer.fontCss?.() ?? ''), width);
    return {
      width: preview.width,
      contentHeight: preview.contentHeight,
      capturedHeight: preview.capturedHeight,
      consoleMessages: preview.consoleMessages,
      ...(errors.length ? { missingImages: errors } : {}),
      ...(played.errors.length ? { missingVideos: played.errors } : {}),
      ...(Object.keys(played.videos).length ? { videos: 'Videos are not drawn in previews; a poster image shows in their place.' } : {}),
      // The MCP shim sends these as image content, not text.
      mcp_images: [{ mimeType: 'image/png', data: preview.png.toString('base64') }]
    };
  }
}
