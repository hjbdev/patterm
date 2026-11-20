type RendererBackendName = 'webgpu' | 'webgl' | 'unavailable';
type TerminalCursorShape = 'block' | 'beam' | 'underline' | 'hidden';
type TerminalFrameKind = 'snapshot' | 'damage';

const FLAG_INVERSE = 0b0000_0000_0000_0001;
const FLAG_BOLD = 0b0000_0000_0000_0010;
const FLAG_ITALIC = 0b0000_0000_0000_0100;
const FLAG_UNDERLINE = 0b0000_0000_0000_1000;
const FLAG_WIDE_CHAR = 0b0000_0000_0010_0000;
const FLAG_WIDE_CHAR_SPACER = 0b0000_0000_0100_0000;
const FLAG_DIM = 0b0000_0000_1000_0000;
const FLAG_HIDDEN = 0b0000_0001_0000_0000;
const FLAG_LEADING_WIDE_CHAR_SPACER = 0b0000_0100_0000_0000;

export interface TerminalGridSize {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export interface TerminalCell {
  char: string;
  flags: number;
  fg: number | string;
  bg: number | string;
  hyperlink?: string;
}

export interface TerminalCursor {
  col: number;
  row: number;
  visible: boolean;
  shape: TerminalCursorShape;
}

interface TerminalRenderState {
  cols: number;
  rows: number;
  cells: TerminalCell[][];
  cursor: TerminalCursor;
  fontSize: number;
  fontFamily: string;
  cellWidth: number;
  cellHeight: number;
}

interface TerminalBackgroundRun {
  row: number;
  startCol: number;
  colCount: number;
  color: string;
}

export interface TerminalResizeTarget extends TerminalGridSize {
  resizeSeq: number;
}

export interface TerminalRendererOptions {
  fontSize?: number;
  fontFamily?: string;
}

interface TerminalFrameDecision {
  action: 'applied' | 'dropped' | 'ignored';
  reason: string;
  frame?: TerminalFrameDebugData;
}

interface TerminalFrameDebugData {
  processId: string;
  frameKind: TerminalFrameKind;
  frameSeq: number;
  epoch: number;
  resizeSeq: number;
  cols: number;
  rows: number;
  runCount: number;
}

export interface ParsedDamageFrame {
  processId: string;
  frameKind: TerminalFrameKind;
  frameSeq: number;
  epoch: number;
  resizeSeq: number;
  cols: number;
  rows: number;
  cursor: TerminalCursor;
  runs: ParsedDamageRun[];
}

export interface ParsedDamageRun {
  row: number;
  startCol: number;
  cells: TerminalCell[];
}

interface TerminalRendererBackend {
  readonly name: RendererBackendName;
  mount(): void;
  resize(): void;
  render(state: TerminalRenderState, damagedRows?: Set<number>): void;
  dispose(): void;
}

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
  getPreferredCanvasFormat?: () => string;
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuDeviceLike {
  limits?: { maxTextureDimension2D?: number };
  lost?: Promise<unknown>;
  queue: {
    submit(commandBuffers: unknown[]): void;
    writeBuffer(buffer: GpuBufferLike, offset: number, data: Float32Array): void;
    copyExternalImageToTexture(source: { source: HTMLCanvasElement; origin?: [number, number] }, destination: { texture: GpuTextureLike; origin?: [number, number] }, size: [number, number]): void;
  };
  createBindGroup(descriptor: unknown): GpuBindGroupLike;
  createBuffer(descriptor: { size: number; usage: number }): GpuBufferLike;
  createCommandEncoder(): GpuCommandEncoderLike;
  createRenderPipeline(descriptor: unknown): GpuRenderPipelineLike;
  createSampler(descriptor: unknown): GpuSamplerLike;
  createShaderModule(descriptor: { code: string }): GpuShaderModuleLike;
  createTexture(descriptor: unknown): GpuTextureLike;
}

interface GpuVertexBufferState {
  buffer: GpuBufferLike | null;
  capacityBytes: number;
}

interface GpuCanvasContextLike {
  configure(config: unknown): void;
  getCurrentTexture(): GpuTextureLike;
}

interface GpuCommandEncoderLike {
  beginRenderPass(descriptor: unknown): GpuRenderPassLike;
  finish(): unknown;
}

interface GpuRenderPassLike {
  end(): void;
  setBindGroup(index: number, bindGroup: GpuBindGroupLike): void;
  setPipeline(pipeline: GpuRenderPipelineLike): void;
  setVertexBuffer(slot: number, buffer: GpuBufferLike): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
}

interface GpuRenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}

interface GpuTextureLike {
  destroy?: () => void;
  createView(): unknown;
}

type GpuBindGroupLike = object;
type GpuBufferLike = { destroy?: () => void };
type GpuSamplerLike = object;
type GpuShaderModuleLike = object;

const GPU_BUFFER_USAGE_COPY_DST = 0x8;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_TEXTURE_USAGE_COPY_DST = 0x2;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const TERMINAL_FRAME_VERSION = 3;
const TERMINAL_BACKGROUND_U32 = 0x151515;
const TERMINAL_FOREGROUND_U32 = 0xfafafa;
const TERMINAL_MUTED_FOREGROUND_U32 = 0xa1a1aa;
const TERMINAL_CURSOR_U32 = 0xfafafa;
const TERMINAL_CURSOR_FOREGROUND_U32 = TERMINAL_BACKGROUND_U32;
const INV_255 = 1 / 255;
const DEFAULT_TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace';
const MAX_CACHED_TERMINAL_GRIDS = 8;
const MAX_CACHED_GPU_ATLASES = 4;
// Damage frames carry a u32 epoch, so -1 never matches. A restored grid then
// accepts only the next snapshot and never applies damage to stale cells.
const RESTORED_GRID_EPOCH = -1;

export interface TerminalGridSnapshot {
  cols: number;
  rows: number;
  cells: TerminalCell[][];
  cursor: TerminalCursor;
}

// The last painted grid of recently viewed PTYs. Switching back paints this
// immediately; the fresh sidecar snapshot then replaces it. Plain objects keep
// terminal cells out of Vue reactivity.
const terminalGridCache = new Map<string, TerminalGridSnapshot>();

export class TerminalRenderer {
  private backend: TerminalRendererBackend | null = null;
  private cols = 0;
  private rows = 0;
  private epoch = 0;
  private cells: TerminalCell[][] = [];
  private cursor: TerminalCursor = { col: 0, row: 0, visible: true, shape: 'block' };
  private resizeTarget: TerminalResizeTarget | null = null;
  private lastFrameDecision: TerminalFrameDecision | null = null;
  private cssCellWidth = 9;
  private fontSizePx = 14;
  private fontFamily = DEFAULT_TERMINAL_FONT_FAMILY;
  private cssCellHeight = 18;
  private hasGrid = false;
  private readonly textDecoder = new TextDecoder();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: TerminalRendererOptions = {}
  ) {
    this.fontFamily = options.fontFamily?.trim() || this.fontFamily;
    this.setFontMetrics(options.fontSize ?? this.fontSizePx);
  }

  mount(): void {
    this.resizeToDisplaySize();
    this.backend = this.createBackend();
    this.backend.mount();
  }

  renderPlaceholder(): void {
    this.backend?.render(this.renderState());
  }

  clear(): void {
    const size = this.gridSize();
    this.resizeTarget = null;
    this.cols = size.cols;
    this.rows = size.rows;
    this.epoch = 0;
    this.cursor = { col: 0, row: 0, visible: false, shape: 'hidden' };
    this.cells = Array.from({ length: size.rows }, () => Array.from({ length: size.cols }, () => blankCell()));
    this.hasGrid = false;
    this.backend?.render(this.renderState());
  }

  // Keep the current grid for a PTY that is leaving the view. The renderer
  // replaces its cell arrays on clear or restore, so no copy is needed.
  stashGrid(processId: string): void {
    if (!this.hasGrid || this.cols < 1 || this.rows < 1) return;
    terminalGridCache.delete(processId);
    terminalGridCache.set(processId, { cols: this.cols, rows: this.rows, cells: this.cells, cursor: { ...this.cursor } });
    while (terminalGridCache.size > MAX_CACHED_TERMINAL_GRIDS) {
      const oldest = terminalGridCache.keys().next().value;
      if (oldest === undefined) break;
      terminalGridCache.delete(oldest);
    }
  }

  // Paint the cached grid for a PTY that is returning to the view. Damage is
  // ignored until the next snapshot because the grid may be out of date.
  restoreGrid(processId: string): boolean {
    const cached = terminalGridCache.get(processId);
    if (!cached) return false;
    terminalGridCache.delete(processId);
    this.resizeTarget = null;
    this.cols = cached.cols;
    this.rows = cached.rows;
    this.epoch = RESTORED_GRID_EPOCH;
    this.cells = cached.cells;
    this.cursor = cached.cursor;
    this.hasGrid = true;
    this.backend?.render(this.renderState());
    return true;
  }

  linkAt(col: number, row: number): string | null {
    const cell = this.cells[row]?.[col];
    if (!cell?.hyperlink || (cell.flags & FLAG_HIDDEN)) return null;
    try {
      const url = new URL(cell.hyperlink);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  cellMetrics(): { cellWidth: number; cellHeight: number } {
    return {
      cellWidth: Math.max(1, Math.round(this.cssCellWidth)),
      cellHeight: this.cssCellHeight
    };
  }

  gridSize(): TerminalGridSize {
    const rect = this.canvas.getBoundingClientRect();
    const cellWidth = Math.max(1, Math.round(this.cssCellWidth));

    return {
      cols: Math.max(2, Math.floor(rect.width / cellWidth)),
      rows: Math.max(1, Math.floor(rect.height / this.cssCellHeight)),
      cellWidth,
      cellHeight: this.cssCellHeight
    };
  }

  resizeSurface(renderCurrentState = true): TerminalGridSize {
    this.resizeToDisplaySize();
    this.backend?.resize();
    if (renderCurrentState) {
      this.backend?.render(this.renderState());
    }
    return this.gridSize();
  }

  setResizeTarget(size: TerminalGridSize, resizeSeq: number): void {
    this.resizeTarget = { ...size, resizeSeq };
    this.backend?.render(this.renderState());
  }

  // Drop any pending resize target so the next snapshot is never treated as
  // stale. Used when attaching to a different PTY (terminal tab switch), whose
  // resize-seq counter is independent of the previous terminal's.
  clearResizeTarget(): void {
    this.resizeTarget = null;
  }

  fontSize(): number {
    return this.fontSizePx;
  }

  setFontSize(fontSizePx: number): void {
    this.setFontMetrics(fontSizePx);
    this.resizeTarget = null;
  }

  setFontFamily(fontFamily: string): void {
    const next = fontFamily.trim() || DEFAULT_TERMINAL_FONT_FAMILY;
    if (next === this.fontFamily) return;
    this.fontFamily = next;
    this.setFontMetrics(this.fontSizePx);
    this.resizeTarget = null;
  }

  setFontSettings(settings: { fontSize?: number; fontFamily?: string }): void {
    if (settings.fontFamily !== undefined) {
      this.fontFamily = settings.fontFamily.trim() || DEFAULT_TERMINAL_FONT_FAMILY;
    }
    this.setFontMetrics(settings.fontSize ?? this.fontSizePx);
    this.resizeTarget = null;
  }

  renderCurrentState(): void {
    this.backend?.render(this.renderState());
  }

  debugState(): unknown {
    return {
      backend: this.backend?.name ?? 'unavailable',
      model: { cols: this.cols, rows: this.rows, epoch: this.epoch },
      cursor: this.cursor,
      resizeTarget: this.resizeTarget,
      fontSize: this.fontSizePx,
      fontFamily: this.fontFamily,
      cellWidth: Math.max(1, Math.round(this.cssCellWidth)),
      cellHeight: this.cssCellHeight,
      lastFrameDecision: this.lastFrameDecision
    };
  }

  applyDamageFrame(payload: Uint8Array, expectedProcessId?: string): string | null {
    const frame = parseDamageFrame(payload, this.textDecoder);
    if (!frame) {
      this.lastFrameDecision = { action: 'ignored', reason: 'parse-failed' };
      return null;
    }

    return this.applyParsedDamageFrame(frame, expectedProcessId);
  }

  applyDamageFrames(payloads: Uint8Array[], expectedProcessId?: string): string | null {
    return this.applyParsedDamageFrames(payloads.map((payload) => parseDamageFrame(payload, this.textDecoder)), expectedProcessId);
  }

  // Apply frames that the caller has already parsed, such as the pane's
  // coalesced batch, and render their damage once.
  applyParsedDamageFrames(frames: Array<ParsedDamageFrame | null>, expectedProcessId?: string): string | null {
    const damagedRows = new Set<number>();
    let appliedProcessId: string | null = null;

    for (const frame of frames) {
      if (!frame) {
        this.lastFrameDecision = { action: 'ignored', reason: 'parse-failed' };
        continue;
      }

      const frameProcessId = this.applyParsedDamageFrame(frame, expectedProcessId, damagedRows);
      appliedProcessId = frameProcessId ?? appliedProcessId;
    }

    if (damagedRows.size > 0) {
      this.backend?.render(this.renderState(), damagedRows);
    }

    return appliedProcessId;
  }

  private applyParsedDamageFrame(frame: ParsedDamageFrame, expectedProcessId?: string, batchDamagedRows?: Set<number>): string | null {
    const frameDebug = frameDebugData(frame);
    if (expectedProcessId && frame.processId !== expectedProcessId) {
      this.lastFrameDecision = { action: 'ignored', reason: 'process-mismatch', frame: frameDebug };
      return frame.processId;
    }

    if (this.isStaleResizeFrame(frame)) {
      this.lastFrameDecision = { action: 'dropped', reason: 'stale-resize-frame', frame: frameDebug };
      return frame.processId;
    }

    if (frame.frameKind === 'damage' && (this.epoch !== frame.epoch || this.cols !== frame.cols || this.rows !== frame.rows)) {
      this.lastFrameDecision = { action: 'dropped', reason: 'epoch-or-dimensions-mismatch', frame: frameDebug };
      return frame.processId;
    }

    const damagedRows = new Set<number>();
    const previousCursor = this.cursor;
    const previousCursorRow = previousCursor.row;

    if (frame.frameKind === 'snapshot') {
      this.replaceGrid(frame.cols, frame.rows, frame.epoch);
      this.hasGrid = true;
      for (let row = 0; row < frame.rows; row += 1) damagedRows.add(row);
      if (this.resizeTarget && frame.resizeSeq >= this.resizeTarget.resizeSeq) {
        this.resizeTarget = null;
      }
    } else {
      this.ensureLegacyGrid(frame.cols, frame.rows);
    }
    this.cursor = frame.cursor;

    for (const run of frame.runs) {
      for (let cellIndex = 0; cellIndex < run.cells.length; cellIndex += 1) {
        const col = run.startCol + cellIndex;
        const cellsRow = this.cells[run.row];
        if (cellsRow && col < this.cols) {
          cellsRow[col] = run.cells[cellIndex] ?? blankCell();
        }
      }

      damagedRows.add(run.row);
    }

    if (
      previousCursor.row !== this.cursor.row
      || previousCursor.col !== this.cursor.col
      || previousCursor.visible !== this.cursor.visible
      || previousCursor.shape !== this.cursor.shape
    ) {
      damagedRows.add(previousCursorRow);
      damagedRows.add(this.cursor.row);
    }
    if (batchDamagedRows) {
      for (const row of damagedRows) {
        batchDamagedRows.add(row);
      }
    } else {
      this.backend?.render(this.renderState(), damagedRows);
    }
    this.lastFrameDecision = { action: 'applied', reason: frame.frameKind, frame: frameDebug };

    return frame.processId;
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
  }

  private createBackend(): TerminalRendererBackend {
    if (hasWebGpu()) {
      return new WebGPUTerminalBackend(this.canvas);
    }

    const webgl = this.canvas.getContext('webgl');
    if (webgl) {
      return new WebGLTerminalBackend(this.canvas, webgl);
    }

    return new UnavailableTerminalBackend();
  }

  private replaceGrid(cols: number, rows: number, epoch: number): void {
    this.cols = cols;
    this.rows = rows;
    this.epoch = epoch;
    this.cursor = {
      col: Math.min(this.cursor.col, Math.max(0, cols - 1)),
      row: Math.min(this.cursor.row, Math.max(0, rows - 1)),
      visible: this.cursor.visible,
      shape: this.cursor.shape
    };
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => blankCell()));
  }

  private ensureLegacyGrid(cols: number, rows: number): void {
    if (this.cols === cols && this.rows === rows) {
      return;
    }

    const previousCells = this.cells;
    const previousCols = this.cols;
    const previousRows = this.rows;
    this.cols = cols;
    this.rows = rows;
    this.epoch = 0;
    this.cursor = {
      col: Math.min(this.cursor.col, Math.max(0, cols - 1)),
      row: Math.min(this.cursor.row, Math.max(0, rows - 1)),
      visible: this.cursor.visible,
      shape: this.cursor.shape
    };
    this.cells = Array.from({ length: rows }, (_rowValue, row) => {
      const previousRow = row < previousRows ? previousCells[row] : undefined;
      return Array.from({ length: cols }, (_colValue, col) => (previousRow && col < previousCols ? previousRow[col] ?? blankCell() : blankCell()));
    });
  }

  private renderState(): TerminalRenderState {
    const target = this.resizeTarget;
    const cols = target?.cols ?? this.cols;
    const rows = target?.rows ?? this.rows;
    return {
      cols,
      rows,
      cells: this.cells,
      cursor: {
        col: Math.min(this.cursor.col, Math.max(0, cols - 1)),
        row: Math.min(this.cursor.row, Math.max(0, rows - 1)),
        visible: this.cursor.visible,
        shape: this.cursor.shape
      },
      fontSize: this.fontSizePx,
      fontFamily: this.fontFamily,
      cellWidth: target?.cellWidth ?? Math.max(1, Math.round(this.cssCellWidth)),
      cellHeight: target?.cellHeight ?? this.cssCellHeight
    };
  }

  private isStaleResizeFrame(frame: ParsedDamageFrame): boolean {
    return isFrameStaleForResizeTarget(frame, this.resizeTarget);
  }

  private resizeToDisplaySize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.ceil(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.ceil(rect.height * ratio));

    const measured = measureCellWidth(this.fontSizePx, this.fontFamily);
    if (measured > 0) {
      this.cssCellWidth = measured;
    }
  }

  private setFontMetrics(fontSizePx: number): void {
    this.fontSizePx = Math.max(1, Math.round(fontSizePx));
    this.cssCellHeight = terminalCellHeightForFontSize(this.fontSizePx);
    const measured = measureCellWidth(this.fontSizePx, this.fontFamily);
    if (measured > 0) {
      this.cssCellWidth = measured;
    }
  }
}

export function isFrameStaleForResizeTarget(frame: ParsedDamageFrame, target: TerminalResizeTarget | null): boolean {
  if (!target) return false;
  if (frame.resizeSeq < target.resizeSeq) return true;
  if (frame.resizeSeq !== target.resizeSeq) return false;
  return frame.cols !== target.cols || frame.rows !== target.rows;
}

export const terminalRendererTestFlags = {
  wideChar: FLAG_WIDE_CHAR,
  wideCharSpacer: FLAG_WIDE_CHAR_SPACER,
  leadingWideCharSpacer: FLAG_LEADING_WIDE_CHAR_SPACER,
  hidden: FLAG_HIDDEN
} as const;

export function shouldRenderGlyphForTest(cell: TerminalCell): boolean {
  return !shouldSkipGlyph(cell);
}

export function glyphQuadWidthCellsForTest(flags: number): number {
  return (flags & FLAG_WIDE_CHAR) !== 0 ? 2 : 1;
}

export function boxDrawingSegmentsForTest(char: string): BoxDrawingSegments | null {
  return boxDrawingSegments(char);
}

export function blockElementRectsForTest(char: string): BlockElementRect[] {
  return blockElementRects(char);
}

export function glyphAtlasMetricsForTest(maxTextureSize: number, cssCellWidth: number, cssCellHeight: number, ratio: number): GlyphAtlasMetrics {
  return glyphAtlasMetrics(maxTextureSize, cssCellWidth, cssCellHeight, ratio);
}

export function glyphAtlasUvForTest(metrics: GlyphAtlasMetrics, entry: GlyphAtlasEntry): { u0: number; v0: number; u1: number; v1: number } {
  const atlasWidth = metrics.cols * metrics.slotWidth;
  const atlasHeight = metrics.rows * metrics.slotHeight;
  return {
    u0: (entry.col * metrics.slotWidth + metrics.padding) / atlasWidth,
    v0: (entry.row * metrics.slotHeight + metrics.padding) / atlasHeight,
    u1: (entry.col * metrics.slotWidth + metrics.padding + atlasGlyphWidth(metrics, entry)) / atlasWidth,
    v1: (entry.row * metrics.slotHeight + metrics.padding + metrics.glyphHeight) / atlasHeight
  };
}

export function terminalCellHeightForFontSizeForTest(fontSizePx: number): number {
  return terminalCellHeightForFontSize(fontSizePx);
}

export function backgroundRunsForTest(cells: TerminalCell[][]): TerminalBackgroundRun[] {
  const runs: TerminalBackgroundRun[] = [];
  const cols = cells.reduce((max, row) => Math.max(max, row.length), 0);
  visitBackgroundRuns({ rows: cells.length, cols, cells }, (row, startCol, colCount, color) => {
    runs.push({ row, startCol, colCount, color: colorU32ToHex(color) });
  });
  return runs;
}

function frameDebugData(frame: ParsedDamageFrame): TerminalFrameDebugData {
  return {
    processId: frame.processId,
    frameKind: frame.frameKind,
    frameSeq: frame.frameSeq,
    epoch: frame.epoch,
    resizeSeq: frame.resizeSeq,
    cols: frame.cols,
    rows: frame.rows,
    runCount: frame.runs.length
  };
}

class FloatWriter {
  data: Float32Array;
  length = 0;

  constructor(initialCapacity = 1024) {
    this.data = new Float32Array(initialCapacity);
  }

  reset(): void {
    this.length = 0;
  }

  ensure(extra: number): void {
    const required = this.length + extra;
    if (required <= this.data.length) return;
    let next = this.data.length || 1024;
    while (next < required) next *= 2;
    const grown = new Float32Array(next);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  subarray(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

// Sparse per-row slab allocator in a single Float32Array. Empty rows allocate
// zero space and submit zero vertices; rows that grow on insert allocate a
// tail slot with headroom so character-by-character typing never repacks or
// re-uploads untouched rows. Draw ranges stay in strict row order (0..rows-1).
class RowGeometry {
  data = new Float32Array(0);
  dirtyRanges: Array<[number, number]> = [];
  drawRanges: Array<[number, number]> = [];
  fullUploadNeeded = false;
  usedFloats = 0;
  private activeFloats = 0;
  private slotStart = new Int32Array(0);
  private slotCap = new Int32Array(0);
  private rowLen = new Int32Array(0);
  private key = '';
  private scratch = new FloatWriter(4096);

  constructor(private readonly strideFloats: number) {}

  update(key: string, rowCount: number, damagedRows: Set<number> | undefined, buildRow: (row: number, writer: FloatWriter) => void): void {
    const rebuild = key !== this.key || this.rowLen.length !== rowCount || !damagedRows || damagedRows.size >= rowCount;
    if (rebuild) {
      this.rebuildAll(key, rowCount, buildRow);
      return;
    }

    this.dirtyRanges = [];
    this.fullUploadNeeded = false;
    if (damagedRows.size === 0) return;

    const minSlotFloats = 64 * 6 * this.strideFloats;
    let relocatedOrResized = false;

    for (const row of damagedRows) {
      if (row < 0 || row >= rowCount) continue;
      this.scratch.reset();
      buildRow(row, this.scratch);
      const newLen = this.scratch.length;
      const oldLen = this.rowLen[row]!;
      this.activeFloats += newLen - oldLen;

      if (newLen !== oldLen) relocatedOrResized = true;

      if (newLen <= this.slotCap[row]!) {
        const start = this.slotStart[row]!;
        if (newLen > 0) {
          this.data.set(this.scratch.subarray(), start);
          if (!this.fullUploadNeeded) this.pushDirtyRange(start, start + newLen);
        }
        this.rowLen[row] = newLen;
        continue;
      }

      // Row grew past its slot capacity: allocate a larger slot at the tail
      // so subsequent keystrokes write in-place without repacking the screen.
      relocatedOrResized = true;
      const newCap = Math.max(newLen, this.slotCap[row]! * 2, minSlotFloats);
      if (this.usedFloats + newCap > this.data.length) {
        if (this.usedFloats - this.activeFloats > this.activeFloats && this.activeFloats > 0) {
          this.compactWithRow(row, newLen, newCap);
          continue;
        }
        const grownLen = Math.max(this.data.length * 2, this.usedFloats + newCap + minSlotFloats);
        const grown = new Float32Array(grownLen);
        if (this.usedFloats > 0) grown.set(this.data.subarray(0, this.usedFloats), 0);
        this.data = grown;
        this.fullUploadNeeded = true;
      }

      const start = this.usedFloats;
      this.usedFloats += newCap;
      this.slotStart[row] = start;
      this.slotCap[row] = newCap;
      this.rowLen[row] = newLen;
      this.data.set(this.scratch.subarray(), start);
      if (!this.fullUploadNeeded) this.pushDirtyRange(start, start + newLen);
    }

    if (this.fullUploadNeeded) {
      this.dirtyRanges = this.usedFloats > 0 ? [[0, this.usedFloats]] : [];
    } else if (this.dirtyRanges.length > 1) {
      this.coalesceDirtyRanges();
    }

    if (relocatedOrResized) {
      this.rebuildDrawRanges(rowCount);
    }
  }

  private rebuildAll(key: string, rowCount: number, buildRow: (row: number, writer: FloatWriter) => void): void {
    this.scratch.reset();
    if (this.rowLen.length !== rowCount) {
      this.slotStart = new Int32Array(rowCount);
      this.slotCap = new Int32Array(rowCount);
      this.rowLen = new Int32Array(rowCount);
    }
    for (let row = 0; row < rowCount; row += 1) {
      const start = this.scratch.length;
      buildRow(row, this.scratch);
      const len = this.scratch.length - start;
      this.slotStart[row] = start;
      this.slotCap[row] = len;
      this.rowLen[row] = len;
    }

    const usedFloats = this.scratch.length;
    this.key = key;
    this.usedFloats = usedFloats;
    this.activeFloats = usedFloats;

    if (usedFloats === 0) {
      this.data = new Float32Array(0);
      this.dirtyRanges = [];
      this.drawRanges = [];
      this.fullUploadNeeded = false;
      return;
    }

    const headroom = rowCount > 1 ? Math.min(usedFloats, 256 * 6 * this.strideFloats) : 0;
    const desiredCapacity = usedFloats + headroom;
    if (this.data.length < usedFloats || this.data.length > desiredCapacity * 2 + 65536) {
      this.data = new Float32Array(desiredCapacity);
    }
    this.data.set(this.scratch.subarray(), 0);
    this.dirtyRanges = [[0, usedFloats]];
    this.drawRanges = [[0, usedFloats / this.strideFloats]];
    this.fullUploadNeeded = true;
  }

  private compactWithRow(updatedRow: number, updatedLen: number, updatedCap: number): void {
    const rowCount = this.rowLen.length;
    let total = updatedCap;
    for (let row = 0; row < rowCount; row += 1) {
      if (row !== updatedRow) total += this.rowLen[row]!;
    }
    const headroom = Math.min(total, 256 * 6 * this.strideFloats);
    const next = new Float32Array(total + headroom);
    let cursor = 0;
    for (let row = 0; row < rowCount; row += 1) {
      if (row === updatedRow) {
        next.set(this.scratch.subarray(), cursor);
        this.slotStart[row] = cursor;
        this.slotCap[row] = updatedCap;
        this.rowLen[row] = updatedLen;
        cursor += updatedCap;
      } else {
        const len = this.rowLen[row]!;
        if (len > 0) {
          const oldStart = this.slotStart[row]!;
          next.set(this.data.subarray(oldStart, oldStart + len), cursor);
        }
        this.slotStart[row] = cursor;
        this.slotCap[row] = len;
        cursor += len;
      }
    }
    this.data = next;
    this.usedFloats = cursor;
    this.fullUploadNeeded = true;
  }

  private pushDirtyRange(start: number, end: number): void {
    const previous = this.dirtyRanges.at(-1);
    if (previous && previous[1] === start) previous[1] = end;
    else this.dirtyRanges.push([start, end]);
  }

  private coalesceDirtyRanges(): void {
    this.dirtyRanges.sort((a, b) => a[0] - b[0]);
    let write = 0;
    for (let read = 1; read < this.dirtyRanges.length; read += 1) {
      const current = this.dirtyRanges[read]!;
      const target = this.dirtyRanges[write]!;
      if (current[0] <= target[1]) {
        if (current[1] > target[1]) target[1] = current[1];
      } else {
        write += 1;
        this.dirtyRanges[write] = current;
      }
    }
    this.dirtyRanges.length = write + 1;
  }

  private rebuildDrawRanges(rowCount: number): void {
    const ranges: Array<[number, number]> = [];
    const stride = this.strideFloats;
    let rangeStartFloat = -1;
    let rangeEndFloat = -1;
    for (let row = 0; row < rowCount; row += 1) {
      const len = this.rowLen[row]!;
      if (len === 0) continue;
      const start = this.slotStart[row]!;
      if (start === rangeEndFloat) {
        rangeEndFloat = start + len;
      } else {
        if (rangeStartFloat >= 0) {
          ranges.push([rangeStartFloat / stride, (rangeEndFloat - rangeStartFloat) / stride]);
        }
        rangeStartFloat = start;
        rangeEndFloat = start + len;
      }
    }
    if (rangeStartFloat >= 0) {
      ranges.push([rangeStartFloat / stride, (rangeEndFloat - rangeStartFloat) / stride]);
    }
    this.drawRanges = ranges;
  }
}

function geometryKey(canvas: HTMLCanvasElement, state: TerminalRenderState, atlas: GlyphAtlas): string {
  return `${canvas.width}:${canvas.height}:${state.cols}:${state.rows}:${state.cellWidth}:${state.cellHeight}:${window.devicePixelRatio}:${atlas.fontFamily}:${atlas.fontSize}`;
}

interface GpuAtlasResources {
  atlas: GlyphAtlas;
  texture: GpuTextureLike;
  bindGroup: GpuBindGroupLike;
  refCount: number;
  evicted: boolean;
}

// Adapter, device, pipelines, and glyph atlases outlive a terminal pane. A
// remount then reuses them instead of requesting a device, compiling shaders,
// and rasterising glyphs again. Device loss drops the entry.
interface GpuSharedResources {
  device: GpuDeviceLike;
  format: string;
  colorPipeline: GpuRenderPipelineLike;
  glyphPipeline: GpuRenderPipelineLike;
  sampler: GpuSamplerLike;
  atlases: Map<string, GpuAtlasResources>;
  lostListeners: Set<() => void>;
}

interface GpuSharedResourcesEntry {
  promise: Promise<GpuSharedResources | null>;
  value?: GpuSharedResources | null;
}

const gpuSharedResources = new WeakMap<GpuLike, GpuSharedResourcesEntry>();

function sharedGpuResources(gpu: GpuLike): GpuSharedResourcesEntry {
  const cached = gpuSharedResources.get(gpu);
  if (cached) return cached;
  const entry: GpuSharedResourcesEntry = {
    promise: createGpuSharedResources(gpu).then(
      (resources) => {
        entry.value = resources;
        if (resources) watchGpuDeviceLoss(gpu, entry, resources);
        return resources;
      },
      () => {
        // Retry on the next mount instead of caching a transient failure.
        if (gpuSharedResources.get(gpu) === entry) gpuSharedResources.delete(gpu);
        return null;
      }
    )
  };
  gpuSharedResources.set(gpu, entry);
  return entry;
}

async function createGpuSharedResources(gpu: GpuLike): Promise<GpuSharedResources | null> {
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
  return { device, format, ...createGpuPipelines(device, format), atlases: new Map(), lostListeners: new Set() };
}

function watchGpuDeviceLoss(gpu: GpuLike, entry: GpuSharedResourcesEntry, resources: GpuSharedResources): void {
  void resources.device.lost?.then(() => {
    if (gpuSharedResources.get(gpu) === entry) gpuSharedResources.delete(gpu);
    for (const atlasEntry of resources.atlases.values()) {
      atlasEntry.evicted = true;
      atlasEntry.texture.destroy?.();
    }
    resources.atlases.clear();
    for (const listener of [...resources.lostListeners]) listener();
    resources.lostListeners.clear();
  });
}

function createGpuPipelines(device: GpuDeviceLike, format: string): Pick<GpuSharedResources, 'colorPipeline' | 'glyphPipeline' | 'sampler'> {
  const colorModule = device.createShaderModule({ code: GPU_COLOR_SHADER });
  const glyphModule = device.createShaderModule({ code: GPU_GLYPH_SHADER });
  const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
  const colorPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: colorModule,
      entryPoint: 'vs_main',
      buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x4' }] }]
    },
    fragment: { module: colorModule, entryPoint: 'fs_main', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-list' }
  });
  const glyphPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: glyphModule,
      entryPoint: 'vs_main',
      buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }, { shaderLocation: 2, offset: 16, format: 'float32x4' }] }]
    },
    fragment: { module: glyphModule, entryPoint: 'fs_main', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-list' }
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  return { colorPipeline, glyphPipeline, sampler };
}

function sharedGpuAtlas(resources: GpuSharedResources, key: string, state: TerminalRenderState, ratio: number): GpuAtlasResources {
  const cached = resources.atlases.get(key);
  if (cached) {
    resources.atlases.delete(key);
    resources.atlases.set(key, cached);
    return cached;
  }
  const { device } = resources;
  const atlas = createGlyphAtlas(device.limits?.maxTextureDimension2D ?? 4096, state.fontSize, state.fontFamily, state.cellWidth, state.cellHeight, ratio);
  const texture = device.createTexture({
    size: [atlas.canvas.width, atlas.canvas.height],
    format: 'rgba8unorm',
    usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
  });
  const bindGroup = device.createBindGroup({
    layout: resources.glyphPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: resources.sampler }, { binding: 1, resource: texture.createView() }]
  });
  const created: GpuAtlasResources = { atlas, texture, bindGroup, refCount: 0, evicted: false };
  resources.atlases.set(key, created);
  // Destroy evicted atlas textures once no pane references them so VRAM is not leaked.
  while (resources.atlases.size > MAX_CACHED_GPU_ATLASES) {
    const oldest = resources.atlases.keys().next().value;
    if (oldest === undefined) break;
    const evicted = resources.atlases.get(oldest);
    resources.atlases.delete(oldest);
    if (evicted) {
      evicted.evicted = true;
      if (evicted.refCount <= 0) evicted.texture.destroy?.();
    }
  }
  return created;
}

function releaseGpuAtlasRef(atlasResources: GpuAtlasResources | null): void {
  if (!atlasResources) return;
  atlasResources.refCount = Math.max(0, atlasResources.refCount - 1);
  if (atlasResources.evicted && atlasResources.refCount === 0) {
    atlasResources.texture.destroy?.();
  }
}

class WebGPUTerminalBackend implements TerminalRendererBackend {
  readonly name = 'webgpu' as const;
  private resources: GpuSharedResources | null = null;
  private context: GpuCanvasContextLike | null = null;
  private fallback: WebGLTerminalBackend | null = null;
  private atlasResources: GpuAtlasResources | null = null;
  private atlasKey = '';
  private atlasGeneration = 0;
  private colorGeometry = new RowGeometry(6);
  private glyphGeometry = new RowGeometry(8);
  private cursorGlyphWriter = new FloatWriter(48);
  private previousCells: TerminalCell[][] | null = null;
  private previousGeometryKey = '';
  private colorVertexBuffer: GpuVertexBufferState = { buffer: null, capacityBytes: 0 };
  private glyphVertexBuffer: GpuVertexBufferState = { buffer: null, capacityBytes: 0 };
  private cursorGlyphBuffer: GpuVertexBufferState = { buffer: null, capacityBytes: 0 };
  private lastState: TerminalRenderState | null = null;
  private ready = false;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get atlas(): GlyphAtlas | null {
    return this.atlasResources?.atlas ?? null;
  }

  mount(): void {
    this.initialize();
  }

  resize(): void {
    this.fallback?.resize();
    this.configure();
  }

  render(state: TerminalRenderState, damagedRows?: Set<number>): void {
    this.lastState = state;
    if (this.fallback) {
      this.fallback.render(state, damagedRows);
      return;
    }
    const resources = this.resources;
    if (!this.ready || !resources || !this.context) return;
    const { device } = resources;

    this.ensureAtlas(resources, state);
    const atlasResources = this.atlasResources;
    if (!atlasResources) return;
    const { atlas } = atlasResources;

    const key = geometryKey(this.canvas, state, atlas);
    damagedRows ??= this.previousCells === state.cells && this.previousGeometryKey === key ? new Set<number>() : undefined;
    this.previousCells = state.cells;
    this.previousGeometryKey = key;
    // Another pane may have reclaimed slots in the shared atlas.
    const atlasReclaimed = prepareAtlasForState(atlas, state, damagedRows) || this.atlasGeneration !== atlas.generation;
    this.atlasGeneration = atlas.generation;
    this.colorGeometry.update(key, state.rows, damagedRows, (row, writer) => pushRowColorVertices(writer, this.canvas, state, row, true));
    this.glyphGeometry.update(key, state.rows, atlasReclaimed ? undefined : damagedRows, (row, writer) => pushRowGlyphVertices(writer, this.canvas, atlas, state, row));
    this.cursorGlyphWriter.reset();
    buildCursorGlyphVertices(this.cursorGlyphWriter, this.canvas, atlas, state);
    uploadGpuAtlasIfDirty(device, atlasResources.texture, atlas);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.019, g: 0.027, b: 0.039, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });
    drawGpuGeometry(device, pass, resources.colorPipeline, this.colorVertexBuffer, this.colorGeometry);
    pass.setBindGroup(0, atlasResources.bindGroup);
    drawGpuGeometry(device, pass, resources.glyphPipeline, this.glyphVertexBuffer, this.glyphGeometry);
    drawGpuWriter(device, pass, resources.glyphPipeline, this.cursorGlyphBuffer, this.cursorGlyphWriter, 8);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.disposed = true;
    this.fallback?.dispose();
    this.fallback = null;
    this.releaseDeviceState();
  }

  // Shared resources stay cached for the next pane. Only per-canvas buffers
  // are destroyed here.
  private releaseDeviceState(): void {
    this.resources?.lostListeners.delete(this.handleDeviceLost);
    releaseGpuAtlasRef(this.atlasResources);
    this.colorVertexBuffer.buffer?.destroy?.();
    this.glyphVertexBuffer.buffer?.destroy?.();
    this.cursorGlyphBuffer.buffer?.destroy?.();
    this.ready = false;
    this.resources = null;
    this.atlasResources = null;
    this.atlasKey = '';
    this.previousCells = null;
    this.colorGeometry = new RowGeometry(6);
    this.glyphGeometry = new RowGeometry(8);
    this.colorVertexBuffer = { buffer: null, capacityBytes: 0 };
    this.glyphVertexBuffer = { buffer: null, capacityBytes: 0 };
    this.cursorGlyphBuffer = { buffer: null, capacityBytes: 0 };
  }

  private readonly handleDeviceLost = (): void => {
    this.releaseDeviceState();
    if (!this.disposed) this.initialize();
  };

  private initialize(): void {
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!gpu) return this.mountFallback();
    const entry = sharedGpuResources(gpu);
    // A cached device attaches synchronously, so a remounted pane can paint
    // in the same task.
    if (entry.value !== undefined) return this.attach(entry.value);
    void entry.promise.then((resources) => this.attach(resources));
  }

  private attach(resources: GpuSharedResources | null): void {
    if (this.disposed || this.resources) return;
    if (!resources) return this.mountFallback();
    // A canvas keeps its WebGPU context; reconfigure it with the new device.
    this.context ??= this.canvas.getContext('webgpu') as GpuCanvasContextLike | null;
    if (!this.context) return this.mountFallback();
    this.resources = resources;
    resources.lostListeners.add(this.handleDeviceLost);
    try {
      this.configure();
    } catch {
      this.ready = false;
      return;
    }
    this.ready = true;
    if (this.lastState) this.render(this.lastState);
  }

  private configure(): void {
    if (!this.resources || !this.context) return;
    this.context.configure({
      device: this.resources.device,
      format: this.resources.format,
      alphaMode: 'opaque'
    });
  }

  private ensureAtlas(resources: GpuSharedResources, state: TerminalRenderState): void {
    const ratio = window.devicePixelRatio || 1;
    const key = `${state.fontFamily}:${state.fontSize}:${Math.ceil(state.cellWidth * ratio)}:${Math.ceil(state.cellHeight * ratio)}:${ratio}`;
    if (this.atlasResources && this.atlasKey === key) return;

    const previous = this.atlasResources;
    const next = sharedGpuAtlas(resources, key, state, ratio);
    next.refCount += 1;
    this.atlasResources = next;
    releaseGpuAtlasRef(previous);
    this.atlasKey = key;
    this.atlasGeneration = next.atlas.generation;
    this.previousCells = null;
    this.colorGeometry = new RowGeometry(6);
    this.glyphGeometry = new RowGeometry(8);
  }

  private mountFallback(): void {
    if (this.disposed || this.fallback) return;
    const webgl = this.canvas.getContext('webgl');
    if (!webgl) return;
    this.fallback = new WebGLTerminalBackend(this.canvas, webgl);
    this.fallback.mount();
    if (this.lastState) this.fallback.render(this.lastState);
  }
}

class WebGLTerminalBackend implements TerminalRendererBackend {
  readonly name = 'webgl' as const;
  private colorProgram: WebGLProgram | null = null;
  private glyphProgram: WebGLProgram | null = null;
  private colorLocations: ColorProgramLocations | null = null;
  private glyphLocations: GlyphProgramLocations | null = null;
  private colorBuffer: WebGLBuffer | null = null;
  private glyphBuffer: WebGLBuffer | null = null;
  private rowColorBuffer: WebGLBuffer | null = null;
  private rowGlyphBuffer: WebGLBuffer | null = null;
  private rowColorBytes = 0;
  private rowGlyphBytes = 0;
  private underlineGeometry = new RowGeometry(6);
  private underlineBuffer: WebGLBuffer | null = null;
  private underlineBytes = 0;
  private atlasTexture: WebGLTexture | null = null;
  private atlas: GlyphAtlas | null = null;
  private atlasKey = '';
  private colorGeometry = new RowGeometry(6);
  private glyphGeometry = new RowGeometry(8);
  private cursorColorWriter = new FloatWriter(36);
  private cursorGlyphWriter = new FloatWriter(48);
  private previousCells: TerminalCell[][] | null = null;
  private previousGeometryKey = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext
  ) {}

  mount(): void {
    this.colorProgram = createProgram(this.gl, COLOR_VERTEX_SHADER, COLOR_FRAGMENT_SHADER);
    this.glyphProgram = createProgram(this.gl, GLYPH_VERTEX_SHADER, GLYPH_FRAGMENT_SHADER);
    this.colorLocations = {
      position: this.gl.getAttribLocation(this.colorProgram, 'a_position'),
      color: this.gl.getAttribLocation(this.colorProgram, 'a_color')
    };
    this.glyphLocations = {
      position: this.gl.getAttribLocation(this.glyphProgram, 'a_position'),
      texcoord: this.gl.getAttribLocation(this.glyphProgram, 'a_texcoord'),
      color: this.gl.getAttribLocation(this.glyphProgram, 'a_color'),
      atlas: this.gl.getUniformLocation(this.glyphProgram, 'u_atlas')
    };
    this.colorBuffer = this.gl.createBuffer();
    this.glyphBuffer = this.gl.createBuffer();
    this.rowColorBuffer = this.gl.createBuffer();
    this.rowGlyphBuffer = this.gl.createBuffer();
    this.underlineBuffer = this.gl.createBuffer();
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.resize();
  }

  resize(): void {
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(state: TerminalRenderState, damagedRows?: Set<number>): void {
    if (!this.underlineBuffer || !this.rowColorBuffer || !this.rowGlyphBuffer || !this.colorProgram || !this.glyphProgram || !this.colorLocations || !this.glyphLocations || !this.colorBuffer || !this.glyphBuffer) {
      return;
    }

    this.resize();
    this.ensureAtlas(state);
    if (!this.atlas || !this.atlasTexture) return;
    this.gl.clearColor(...TERMINAL_BACKGROUND_RGB, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    const key = geometryKey(this.canvas, state, this.atlas);
    damagedRows ??= this.previousCells === state.cells && this.previousGeometryKey === key ? new Set<number>() : undefined;
    this.previousCells = state.cells;
    this.previousGeometryKey = key;
    const atlasReclaimed = prepareAtlasForState(this.atlas, state, damagedRows);
    this.colorGeometry.update(key, state.rows, damagedRows, (row, writer) => pushRowColorVertices(writer, this.canvas, state, row, false));
    this.glyphGeometry.update(key, state.rows, atlasReclaimed ? undefined : damagedRows, (row, writer) => pushRowGlyphVertices(writer, this.canvas, this.atlas!, state, row));
    uploadAtlasIfDirty(this.gl, this.atlasTexture, this.atlas);
    this.rowColorBytes = uploadGlGeometry(this.gl, this.rowColorBuffer, this.colorGeometry, this.rowColorBytes);
    drawGlColorRanges(this.gl, this.colorProgram, this.colorLocations, this.rowColorBuffer, this.colorGeometry.drawRanges);
    this.rowGlyphBytes = uploadGlGeometry(this.gl, this.rowGlyphBuffer, this.glyphGeometry, this.rowGlyphBytes);
    drawGlGlyphRanges(this.gl, this.glyphProgram, this.glyphLocations, this.rowGlyphBuffer, this.atlasTexture, this.glyphGeometry.drawRanges);
    this.underlineGeometry.update(key, state.rows, damagedRows, (row, writer) => pushRowUnderlineVertices(writer, this.canvas, state, row));
    this.underlineBytes = uploadGlGeometry(this.gl, this.underlineBuffer, this.underlineGeometry, this.underlineBytes);
    drawGlColorRanges(this.gl, this.colorProgram, this.colorLocations, this.underlineBuffer, this.underlineGeometry.drawRanges);
    this.renderCursor(state);
  }

  dispose(): void {
    if (this.colorProgram) this.gl.deleteProgram(this.colorProgram);
    if (this.glyphProgram) this.gl.deleteProgram(this.glyphProgram);
    if (this.colorBuffer) this.gl.deleteBuffer(this.colorBuffer);
    if (this.glyphBuffer) this.gl.deleteBuffer(this.glyphBuffer);
    if (this.rowColorBuffer) this.gl.deleteBuffer(this.rowColorBuffer);
    if (this.rowGlyphBuffer) this.gl.deleteBuffer(this.rowGlyphBuffer);
    if (this.underlineBuffer) this.gl.deleteBuffer(this.underlineBuffer);
    if (this.atlasTexture) this.gl.deleteTexture(this.atlasTexture);
    this.colorLocations = null;
    this.glyphLocations = null;
  }

  private ensureAtlas(state: TerminalRenderState): void {
    const ratio = window.devicePixelRatio || 1;
    const key = `${state.fontFamily}:${state.fontSize}:${Math.ceil(state.cellWidth * ratio)}:${Math.ceil(state.cellHeight * ratio)}:${ratio}`;
    if (this.atlas && this.atlasTexture && this.atlasKey === key) return;

    if (this.atlasTexture) this.gl.deleteTexture(this.atlasTexture);
    this.atlas = createGlyphAtlas(Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) || 4096, state.fontSize, state.fontFamily, state.cellWidth, state.cellHeight, ratio);
    this.atlasTexture = createAtlasTexture(this.gl, this.atlas.canvas);
    this.atlasKey = key;
    this.previousCells = null;
    this.colorGeometry = new RowGeometry(6);
    this.glyphGeometry = new RowGeometry(8);
    this.underlineGeometry = new RowGeometry(6);
  }

  private renderCursor(state: TerminalRenderState): void {
    if (!this.colorProgram || !this.colorLocations || !this.colorBuffer || !this.glyphProgram || !this.glyphLocations || !this.glyphBuffer || !this.atlas || !this.atlasTexture) return;
    if (!state.cursor.visible || state.cursor.shape === 'hidden') return;
    this.cursorColorWriter.reset();
    if (state.cursor.shape === 'beam') {
      pushColorRect(this.cursorColorWriter, this.canvas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, Math.max(1, 2 * (window.devicePixelRatio || 1)), TERMINAL_CURSOR_U32, 'left');
      drawColorVertices(this.gl, this.colorProgram, this.colorLocations, this.colorBuffer, this.cursorColorWriter.subarray());
      return;
    }
    if (state.cursor.shape === 'underline') {
      pushColorRect(this.cursorColorWriter, this.canvas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, Math.max(1, 2 * (window.devicePixelRatio || 1)), TERMINAL_CURSOR_U32, 'bottom');
      drawColorVertices(this.gl, this.colorProgram, this.colorLocations, this.colorBuffer, this.cursorColorWriter.subarray());
      return;
    }

    pushColorQuad(this.cursorColorWriter, this.canvas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, TERMINAL_CURSOR_U32);
    drawColorVertices(this.gl, this.colorProgram, this.colorLocations, this.colorBuffer, this.cursorColorWriter.subarray());

    const cell = state.cells[state.cursor.row]?.[state.cursor.col] ?? BLANK_CELL;
    if (!shouldSkipGlyph(cell)) {
      ensureGlyph(this.atlas, cell.char, cell.flags);
      this.cursorGlyphWriter.reset();
      pushGlyphQuad(this.cursorGlyphWriter, this.canvas, this.atlas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, cell.char, TERMINAL_CURSOR_FOREGROUND_U32, cell.flags);
      uploadAtlasIfDirty(this.gl, this.atlasTexture, this.atlas);
      drawGlyphVertices(this.gl, this.glyphProgram, this.glyphLocations, this.glyphBuffer, this.atlasTexture, this.cursorGlyphWriter.subarray());
    }
  }
}

class UnavailableTerminalBackend implements TerminalRendererBackend {
  readonly name = 'unavailable' as const;
  mount(): void {}
  resize(): void {}
  render(): void {}
  dispose(): void {}
}

interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  fontSize: number;
  fontFamily: string;
  cols: number;
  slotWidth: number;
  slotHeight: number;
  glyphWidth: number;
  glyphHeight: number;
  overdrawX: number;
  overdrawY: number;
  padding: number;
  capacity: number;
  nextIndex: number;
  glyphs: Map<number, GlyphAtlasEntry>;
  dirty: { x: number; y: number; right: number; bottom: number } | null;
  freeSlots: number[];
  overflowed: boolean;
  // Increments when slots are reclaimed, which moves glyphs other panes may
  // still reference in their cached geometry.
  generation: number;
  uploadCanvas?: HTMLCanvasElement;
}

interface ColorProgramLocations {
  position: number;
  color: number;
}

interface GlyphProgramLocations {
  position: number;
  texcoord: number;
  color: number;
  atlas: WebGLUniformLocation | null;
}

export interface GlyphAtlasEntry {
  col: number;
  row: number;
  // Wide glyphs span this slot and the next one in the same atlas row.
  wide?: boolean;
  // Colour glyphs, such as emoji, keep their atlas colours instead of the cell foreground.
  color?: boolean;
}

export interface GlyphAtlasMetrics {
  slotWidth: number;
  slotHeight: number;
  glyphWidth: number;
  glyphHeight: number;
  overdrawX: number;
  overdrawY: number;
  padding: number;
  cols: number;
  rows: number;
}

const COLOR_VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec4 a_color;
varying vec4 v_color;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_color = a_color;
}`;

const COLOR_FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = v_color;
}`;

const GLYPH_VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texcoord;
attribute vec4 a_color;
varying vec2 v_texcoord;
varying vec4 v_color;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texcoord = a_texcoord;
  v_color = a_color;
}`;

const GLYPH_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_atlas;
varying vec2 v_texcoord;
varying vec4 v_color;
void main() {
  vec4 sampleColor = texture2D(u_atlas, v_texcoord);
  gl_FragColor = vec4(v_color.rgb * sampleColor.rgb, v_color.a * sampleColor.a);
}`;

const GPU_COLOR_SHADER = `
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return in.color;
}`;

const GPU_GLYPH_SHADER = `
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) texcoord: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@group(0) @binding(0) var atlasSampler: sampler;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;

@vertex
fn vs_main(@location(0) position: vec2<f32>, @location(1) texcoord: vec2<f32>, @location(2) color: vec4<f32>) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.texcoord = texcoord;
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let sampleColor = textureSample(atlasTexture, atlasSampler, in.texcoord);
  return vec4<f32>(in.color.rgb * sampleColor.rgb, in.color.a * sampleColor.a);
}`;

function decodeCell(view: DataView, offset: number): TerminalCell {
  const codepoint = view.getUint32(offset, true);
  const flags = view.getUint16(offset + 4, true);
  const fgKind = view.getUint8(offset + 6);
  const fgValue = view.getUint32(offset + 7, true);
  const bgKind = view.getUint8(offset + 11);
  const bgValue = view.getUint32(offset + 12, true);

  return {
    char: codepointToString(codepoint),
    flags,
    fg: decodeColorU32(fgKind, fgValue, TERMINAL_FOREGROUND_U32),
    bg: decodeColorU32(bgKind, bgValue, TERMINAL_BACKGROUND_U32)
  };
}

export function parseDamageFrame(payload: Uint8Array, textDecoder: TextDecoder = new TextDecoder()): ParsedDamageFrame | null {
  return parseVersionedDamageFrame(payload, textDecoder) ?? parseDamageFrameLayout(payload, textDecoder, 6) ?? parseDamageFrameLayout(payload, textDecoder, 2) ?? parseDamageFrameLayout(payload, textDecoder, 1) ?? parseDamageFrameLayout(payload, textDecoder, 0);
}

function parseVersionedDamageFrame(payload: Uint8Array, textDecoder: TextDecoder): ParsedDamageFrame | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const readU8 = (): number | null => {
    if (offset + 1 > view.byteLength) return null;
    const value = view.getUint8(offset);
    offset += 1;
    return value;
  };
  const readU16 = (): number | null => {
    if (offset + 2 > view.byteLength) return null;
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const readU32 = (): number | null => {
    if (offset + 4 > view.byteLength) return null;
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const version = readU16();
  if (version !== 2 && version !== TERMINAL_FRAME_VERSION) return null;
  const rawFrameKind = readU8();
  const frameSeq = readU32();
  const epoch = readU32();
  const resizeSeq = readU32();
  if (rawFrameKind === null || frameSeq === null || epoch === null || resizeSeq === null) return null;
  if (rawFrameKind !== 0 && rawFrameKind !== 1) return null;

  const processIdLength = readU16();
  if (processIdLength === null || offset + processIdLength > payload.byteLength) return null;
  const processId = textDecoder.decode(payload.subarray(offset, offset + processIdLength));
  offset += processIdLength;

  const cols = readU16();
  const rows = readU16();
  const cursorCol = readU16();
  const cursorRow = readU16();
  const rawVisible = readU8();
  const rawShape = readU8();
  const runCount = readU16();
  if (cols === null || rows === null || cursorCol === null || cursorRow === null || rawVisible === null || rawShape === null || runCount === null) return null;
  if (cols < 1 || rows < 1 || rawVisible > 1 || rawShape > 3) return null;

  const runs = parseRuns(view, offset, rows, cols, runCount);
  if (!runs) return null;
  offset = runs.offset;
  if (version === 3) {
    const linkCount = readU16();
    if (linkCount === null) return null;
    for (let index = 0; index < linkCount; index += 1) {
      const runIndex = readU16();
      const start = readU16();
      const count = readU16();
      const uriLength = readU16();
      if (runIndex === null || start === null || count === null || uriLength === null) return null;
      const run = runs.runs[runIndex];
      if (!run || count === 0 || start + count > run.cells.length || offset + uriLength > view.byteLength) return null;
      const uri = textDecoder.decode(payload.subarray(offset, offset + uriLength));
      offset += uriLength;
      for (let cell = start; cell < start + count; cell += 1) {
        run.cells[cell]!.hyperlink = uri;
      }
    }
  }
  if (offset !== view.byteLength) return null;
  if (rawFrameKind === 0 && !coversFullGrid(runs.runs, rows, cols)) return null;

  let cursorShape = decodeCursorShape(rawShape);
  let cursorVisible = rawVisible === 1;
  if (cursorShape === 'hidden') cursorVisible = false;
  if (!cursorVisible) cursorShape = 'hidden';

  return {
    processId,
    frameKind: rawFrameKind === 0 ? 'snapshot' : 'damage',
    frameSeq,
    epoch,
    resizeSeq,
    cols,
    rows,
    cursor: {
      col: Math.min(cursorCol, Math.max(0, cols - 1)),
      row: Math.min(cursorRow, Math.max(0, rows - 1)),
      visible: cursorVisible,
      shape: cursorShape
    },
    runs: runs.runs
  };
}

function parseDamageFrameLayout(payload: Uint8Array, textDecoder: TextDecoder, cursorMetadataBytes: 0 | 1 | 2 | 6): ParsedDamageFrame | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const readU8 = (): number | null => {
    if (offset + 1 > view.byteLength) return null;
    const value = view.getUint8(offset);
    offset += 1;
    return value;
  };
  const readU16 = (): number | null => {
    if (offset + 2 > view.byteLength) return null;
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const readU32 = (): number | null => {
    if (offset + 4 > view.byteLength) return null;
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const processIdLength = readU16();
  if (processIdLength === null || offset + processIdLength > payload.byteLength) return null;
  const processId = textDecoder.decode(payload.subarray(offset, offset + processIdLength));
  offset += processIdLength;

  const cols = readU16();
  const rows = readU16();
  const cursorCol = readU16();
  const cursorRow = readU16();
  if (cols === null || rows === null || cursorCol === null || cursorRow === null || cols < 1 || rows < 1) return null;

  let cursorVisible = true;
  let cursorShape: TerminalCursorShape = 'block';
  let resizeSeq = 0;
  if (cursorMetadataBytes >= 1) {
    const rawVisible = readU8();
    if (rawVisible === null || rawVisible > 1) return null;
    cursorVisible = rawVisible === 1;
  }
  if (cursorMetadataBytes >= 2) {
    const rawShape = readU8();
    if (rawShape === null || rawShape > 3) return null;
    cursorShape = decodeCursorShape(rawShape);
    if (cursorShape === 'hidden') cursorVisible = false;
  }
  if (cursorMetadataBytes >= 6) {
    const rawResizeSeq = readU32();
    if (rawResizeSeq === null) return null;
    resizeSeq = rawResizeSeq;
  }

  const runCount = readU16();
  if (runCount === null) return null;
  const parsedRuns = parseRuns(view, offset, rows, cols, runCount);
  if (!parsedRuns) return null;
  offset = parsedRuns.offset;

  if (offset !== view.byteLength) return null;

  return {
    processId,
    frameKind: 'snapshot',
    frameSeq: 0,
    epoch: 0,
    resizeSeq,
    cols,
    rows,
    cursor: {
      col: Math.min(cursorCol, Math.max(0, cols - 1)),
      row: Math.min(cursorRow, Math.max(0, rows - 1)),
      visible: cursorVisible,
      shape: cursorVisible ? cursorShape : 'hidden'
    },
    runs: parsedRuns.runs
  };
}

function parseRuns(view: DataView, initialOffset: number, rows: number, cols: number, runCount: number): { runs: ParsedDamageRun[]; offset: number } | null {
  let offset = initialOffset;
  const runs: ParsedDamageRun[] = [];

  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    if (offset + 6 > view.byteLength) return null;
    const row = view.getUint16(offset, true);
    offset += 2;
    const startCol = view.getUint16(offset, true);
    offset += 2;
    const cellCount = view.getUint16(offset, true);
    offset += 2;
    if (row >= rows || startCol >= cols || startCol + cellCount > cols) return null;
    if (offset + cellCount * 16 > view.byteLength) return null;

    const cells: TerminalCell[] = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      cells.push(decodeCell(view, offset));
      offset += 16;
    }
    runs.push({ row, startCol, cells });
  }

  return { runs, offset };
}

function coversFullGrid(runs: ParsedDamageRun[], rows: number, cols: number): boolean {
  if (runs.length !== rows) return false;
  const coveredRows = new Set<number>();
  for (const run of runs) {
    if (run.startCol !== 0 || run.cells.length !== cols) return false;
    coveredRows.add(run.row);
  }
  return coveredRows.size === rows;
}

function decodeCursorShape(value: number): TerminalCursorShape {
  if (value === 1) return 'beam';
  if (value === 2) return 'underline';
  if (value === 3) return 'hidden';
  return 'block';
}

function hasWebGpu(): boolean {
  return Boolean((navigator as unknown as { gpu?: unknown }).gpu && HTMLCanvasElement.prototype.getContext);
}

const ASCII_CHARS: readonly string[] = Array.from({ length: 128 }, (_v, code) => (code === 0 ? ' ' : String.fromCharCode(code)));

function codepointToString(codepoint: number): string {
  if (codepoint < 128) return ASCII_CHARS[codepoint]!;
  if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(codepoint);
}

const BLANK_CELL: TerminalCell = { char: ' ', flags: 0, fg: TERMINAL_FOREGROUND_U32, bg: TERMINAL_BACKGROUND_U32 };

function blankCell(): TerminalCell {
  return BLANK_CELL;
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('failed to create WebGL program');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'failed to link WebGL program');
  }
  return program;
}

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('failed to create WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'failed to compile WebGL shader');
  }
  return shader;
}

function createGlyphAtlas(maxTextureSize: number, fontSize: number, fontFamily: string, cssCellWidth: number, cssCellHeight: number, ratio: number): GlyphAtlas {
  const { slotWidth, slotHeight, glyphWidth, glyphHeight, overdrawX, overdrawY, padding, cols, rows } = glyphAtlasMetrics(maxTextureSize, cssCellWidth, cssCellHeight, ratio);
  const canvas = document.createElement('canvas');
  canvas.width = cols * slotWidth;
  canvas.height = rows * slotHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('failed to create glyph atlas canvas');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.textBaseline = 'top';
  return { canvas, context, fontSize, fontFamily, cols, slotWidth, slotHeight, glyphWidth, glyphHeight, overdrawX, overdrawY, padding, capacity: cols * rows, nextIndex: 0, glyphs: new Map(), dirty: null, freeSlots: [], overflowed: false, generation: 0 };
}

function glyphAtlasMetrics(maxTextureSize: number, cssCellWidth: number, cssCellHeight: number, ratio: number): GlyphAtlasMetrics {
  const cellWidth = Math.max(1, Math.ceil(cssCellWidth * ratio));
  const cellHeight = Math.max(1, Math.ceil(cssCellHeight * ratio));
  const overdrawX = Math.max(2, Math.ceil(3 * ratio));
  const overdrawY = Math.max(1, Math.ceil(2 * ratio));
  const glyphWidth = cellWidth + overdrawX * 2;
  const glyphHeight = cellHeight + overdrawY * 2;
  const padding = Math.max(2, Math.ceil(2 * ratio));
  const slotWidth = glyphWidth + padding * 2;
  const slotHeight = glyphHeight + padding * 2;
  const cols = Math.max(1, Math.min(64, Math.floor(maxTextureSize / slotWidth)));
  const rows = Math.max(1, Math.min(64, Math.floor(maxTextureSize / slotHeight)));
  return { slotWidth, slotHeight, glyphWidth, glyphHeight, overdrawX, overdrawY, padding, cols, rows };
}

function terminalCellHeightForFontSize(fontSizePx: number): number {
  return Math.max(1, Math.round(fontSizePx * 1.2857142857));
}

function createAtlasTexture(gl: WebGLRenderingContext, canvas: HTMLCanvasElement): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('failed to create glyph atlas texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  return texture;
}

function uploadAtlasIfDirty(gl: WebGLRenderingContext, texture: WebGLTexture, atlas: GlyphAtlas): void {
  const dirty = atlas.dirty;
  if (!dirty) return;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // WebGL 1 cannot select a source rectangle. A small staging canvas avoids
  // uploading the complete atlas or reading pixels back to JavaScript.
  const canvas = atlas.uploadCanvas ??= document.createElement('canvas');
  canvas.width = dirty.right - dirty.x;
  canvas.height = dirty.bottom - dirty.y;
  canvas.getContext('2d')!.drawImage(atlas.canvas, dirty.x, dirty.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, dirty.x, dirty.y, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  atlas.dirty = null;
}

function uploadGlGeometry(gl: WebGLRenderingContext, buffer: WebGLBuffer, geometry: RowGeometry, previousBytes: number): number {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  if (previousBytes < geometry.data.byteLength) {
    gl.bufferData(gl.ARRAY_BUFFER, geometry.data, gl.DYNAMIC_DRAW);
    geometry.fullUploadNeeded = false;
    return geometry.data.byteLength;
  }
  if (geometry.fullUploadNeeded) {
    if (geometry.usedFloats > 0) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, geometry.data.subarray(0, geometry.usedFloats));
    }
    geometry.fullUploadNeeded = false;
    return previousBytes;
  }
  for (const [start, end] of geometry.dirtyRanges) {
    if (end > start) gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, geometry.data.subarray(start, end));
  }
  return previousBytes;
}

function drawGlColorRanges(gl: WebGLRenderingContext, program: WebGLProgram, locations: ColorProgramLocations, buffer: WebGLBuffer, drawRanges: ReadonlyArray<[number, number]>): void {
  if (drawRanges.length === 0) return;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(locations.color);
  gl.vertexAttribPointer(locations.color, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  for (const [firstVertex, vertexCount] of drawRanges) {
    if (vertexCount > 0) gl.drawArrays(gl.TRIANGLES, firstVertex, vertexCount);
  }
}

function drawGlGlyphRanges(gl: WebGLRenderingContext, program: WebGLProgram, locations: GlyphProgramLocations, buffer: WebGLBuffer, texture: WebGLTexture, drawRanges: ReadonlyArray<[number, number]>): void {
  if (drawRanges.length === 0) return;
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(locations.atlas, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = 8 * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(locations.texcoord);
  gl.vertexAttribPointer(locations.texcoord, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  gl.enableVertexAttribArray(locations.color);
  gl.vertexAttribPointer(locations.color, 4, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
  for (const [firstVertex, vertexCount] of drawRanges) {
    if (vertexCount > 0) gl.drawArrays(gl.TRIANGLES, firstVertex, vertexCount);
  }
}

function drawColorVertices(gl: WebGLRenderingContext, program: WebGLProgram, locations: ColorProgramLocations, buffer: WebGLBuffer, vertices: Float32Array): void {
  if (vertices.length === 0) return;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
  const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(locations.color);
  gl.vertexAttribPointer(locations.color, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6);
}

function drawGlyphVertices(gl: WebGLRenderingContext, program: WebGLProgram, locations: GlyphProgramLocations, buffer: WebGLBuffer, texture: WebGLTexture, vertices: Float32Array): void {
  if (vertices.length === 0) return;
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(locations.atlas, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
  const stride = 8 * Float32Array.BYTES_PER_ELEMENT;
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(locations.texcoord);
  gl.vertexAttribPointer(locations.texcoord, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  gl.enableVertexAttribArray(locations.color);
  gl.vertexAttribPointer(locations.color, 4, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
  gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 8);
}

function pushRowUnderlineVertices(writer: FloatWriter, canvas: HTMLCanvasElement, state: TerminalRenderState, row: number): void {
  const cellsRow = state.cells[row];
  if (!cellsRow) return;
  const thickness = Math.max(1, window.devicePixelRatio || 1);
  for (let col = 0; col < state.cols; col += 1) {
    const cell = cellsRow[col];
    if (!cell || (cell.flags & FLAG_UNDERLINE) === 0) continue;
    const foreground = colorToU32((cell.flags & FLAG_INVERSE) !== 0 ? cell.bg : cell.fg);
    pushColorRect(writer, canvas, col, row, state.cellWidth, state.cellHeight, thickness, foreground, 'bottom');
  }
}

function pushRowColorVertices(writer: FloatWriter, canvas: HTMLCanvasElement, state: TerminalRenderState, row: number, includeOverlays: boolean): void {
  pushBackgroundVertices(writer, canvas, state, row, row + 1);
  const ratio = window.devicePixelRatio || 1;
  const underlineHeight = Math.max(1, ratio);
  const cellsRow = state.cells[row];
  if (cellsRow) {
    for (let col = 0; col < state.cols; col += 1) {
      const cell = cellsRow[col];
      if (!cell) continue;
      const flags = cell.flags;
      const inverse = (flags & FLAG_INVERSE) !== 0;
      if (includeOverlays && (flags & FLAG_UNDERLINE) !== 0) {
        const foreground = colorToU32(inverse ? cell.bg : cell.fg);
        pushColorRect(writer, canvas, col, row, state.cellWidth, state.cellHeight, underlineHeight, foreground, 'bottom');
      }
      if ((flags & FLAG_HIDDEN) === 0 && !isWideSpacerCell(cell)) {
        const ch = cell.char;
        if (isDrawableBoxCharacter(ch)) {
          const foreground = colorToU32(inverse ? cell.bg : cell.fg);
          pushBoxDrawing(writer, canvas, col, row, state.cellWidth, state.cellHeight, ch, foreground);
        } else if (isDrawableBlockElement(ch)) {
          const foreground = colorToU32(inverse ? cell.bg : cell.fg);
          pushBlockElement(writer, canvas, col, row, state.cellWidth, state.cellHeight, ch, foreground);
        }
      }
    }
  }

  if (state.cursor.row !== row || !includeOverlays || !state.cursor.visible || state.cursor.shape === 'hidden') return;
  const cursorThickness = Math.max(1, 2 * ratio);
  if (state.cursor.shape === 'beam') {
    pushColorRect(writer, canvas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, cursorThickness, TERMINAL_CURSOR_U32, 'left');
  } else if (state.cursor.shape === 'underline') {
    pushColorRect(writer, canvas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, cursorThickness, TERMINAL_CURSOR_U32, 'bottom');
  } else {
    pushColorQuad(writer, canvas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, TERMINAL_CURSOR_U32);
  }
}

function pushBackgroundVertices(writer: FloatWriter, canvas: HTMLCanvasElement, state: Pick<TerminalRenderState, 'rows' | 'cols' | 'cells' | 'cellWidth' | 'cellHeight'>, startRow = 0, endRow = state.rows): void {
  visitBackgroundRuns(state, (row, startCol, colCount, color) => {
    pushColorQuad(writer, canvas, startCol, row, state.cellWidth, state.cellHeight, color, colCount);
  }, startRow, endRow);
}

function visitBackgroundRuns(state: Pick<TerminalRenderState, 'rows' | 'cols' | 'cells'>, visit: (row: number, startCol: number, colCount: number, color: number) => void, startRow = 0, endRow = state.rows): void {
  for (let row = startRow; row < endRow; row += 1) {
    const cellsRow = state.cells[row];
    let runColor = -1;
    let runStartCol = 0;

    for (let col = 0; col <= state.cols; col += 1) {
      let background = TERMINAL_BACKGROUND_U32;
      if (col < state.cols && cellsRow) {
        const cell = cellsRow[col];
        if (cell) background = cellBackgroundU32(cell);
      }
      if (background === runColor) continue;

      if (runColor >= 0 && runColor !== TERMINAL_BACKGROUND_U32) {
        visit(row, runStartCol, col - runStartCol, runColor);
      }

      runColor = background;
      runStartCol = col;
    }
  }
}

function cellBackgroundU32(cell: TerminalCell): number {
  return colorToU32((cell.flags & FLAG_INVERSE) !== 0 ? cell.fg : cell.bg);
}

function pushRowGlyphVertices(writer: FloatWriter, canvas: HTMLCanvasElement, atlas: GlyphAtlas, state: TerminalRenderState, row: number): void {
  const cellsRow = state.cells[row];
  if (!cellsRow) return;
  for (let col = 0; col < state.cols; col += 1) {
    const cell = cellsRow[col];
    if (!cell || shouldSkipGlyph(cell)) continue;
    const inverse = (cell.flags & FLAG_INVERSE) !== 0;
    const foreground = colorToU32(inverse ? cell.bg : cell.fg);
    pushGlyphQuad(writer, canvas, atlas, col, row, state.cellWidth, state.cellHeight, cell.char, foreground, cell.flags);
  }
}

function buildCursorGlyphVertices(writer: FloatWriter, canvas: HTMLCanvasElement, atlas: GlyphAtlas, state: TerminalRenderState): void {
  if (state.cursor.visible && state.cursor.shape === 'block') {
    const cell = state.cells[state.cursor.row]?.[state.cursor.col] ?? BLANK_CELL;
    if (!shouldSkipGlyph(cell)) {
      pushGlyphQuad(writer, canvas, atlas, state.cursor.col, state.cursor.row, state.cellWidth, state.cellHeight, cell.char, TERMINAL_CURSOR_FOREGROUND_U32, cell.flags);
    }
  }
}

function drawGpuGeometry(device: GpuDeviceLike, pass: GpuRenderPassLike, pipeline: GpuRenderPipelineLike, bufferState: GpuVertexBufferState, geometry: RowGeometry): void {
  if (geometry.drawRanges.length === 0) return;
  const previous = bufferState.buffer;
  const buffer = ensureGpuVertexBuffer(device, bufferState, geometry.usedFloats * 4);
  if (buffer !== previous || geometry.fullUploadNeeded) {
    if (geometry.usedFloats > 0) {
      device.queue.writeBuffer(buffer, 0, geometry.data.subarray(0, geometry.usedFloats));
    }
    geometry.fullUploadNeeded = false;
  } else {
    for (const [start, end] of geometry.dirtyRanges) {
      if (end > start) device.queue.writeBuffer(buffer, start * 4, geometry.data.subarray(start, end));
    }
  }
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, buffer);
  for (const [firstVertex, vertexCount] of geometry.drawRanges) {
    if (vertexCount > 0) {
      if (firstVertex === 0) pass.draw(vertexCount);
      else pass.draw(vertexCount, 1, firstVertex);
    }
  }
}

function drawGpuWriter(device: GpuDeviceLike, pass: GpuRenderPassLike, pipeline: GpuRenderPipelineLike, bufferState: GpuVertexBufferState, writer: FloatWriter, strideFloats: number): void {
  if (writer.length === 0) return;
  const data = writer.subarray();
  const buffer = ensureGpuVertexBuffer(device, bufferState, data.byteLength);
  device.queue.writeBuffer(buffer, 0, data);
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, buffer);
  pass.draw(writer.length / strideFloats);
}

function ensureGpuVertexBuffer(device: GpuDeviceLike, bufferState: GpuVertexBufferState, requiredBytes: number): GpuBufferLike {
  if (bufferState.buffer && bufferState.capacityBytes >= requiredBytes) {
    return bufferState.buffer;
  }

  bufferState.buffer?.destroy?.();
  const capacityBytes = nextPowerOfTwo(Math.max(4, requiredBytes));
  bufferState.buffer = device.createBuffer({ size: capacityBytes, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST });
  bufferState.capacityBytes = capacityBytes;
  return bufferState.buffer;
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

function uploadGpuAtlasIfDirty(device: GpuDeviceLike, texture: GpuTextureLike, atlas: GlyphAtlas): void {
  const dirty = atlas.dirty;
  if (!dirty) return;
  device.queue.copyExternalImageToTexture({ source: atlas.canvas, origin: [dirty.x, dirty.y] }, { texture, origin: [dirty.x, dirty.y] }, [dirty.right - dirty.x, dirty.bottom - dirty.y]);
  atlas.dirty = null;
}

function pushColorQuad(writer: FloatWriter, canvas: HTMLCanvasElement, col: number, row: number, cellWidth: number, cellHeight: number, color: number, widthCells = 1): void {
  const r = ((color >> 16) & 0xff) * INV_255;
  const g = ((color >> 8) & 0xff) * INV_255;
  const b = (color & 0xff) * INV_255;
  const ratio = window.devicePixelRatio || 1;
  const invW = 2 / canvas.width;
  const invH = 2 / canvas.height;
  const x0px = col * cellWidth * ratio;
  const y0px = row * cellHeight * ratio;
  const x1px = x0px + cellWidth * widthCells * ratio;
  const y1px = y0px + cellHeight * ratio;
  pushQuad(writer, x0px * invW - 1, 1 - y0px * invH, x1px * invW - 1, 1 - y1px * invH, r, g, b, 1);
}

function pushColorRect(writer: FloatWriter, canvas: HTMLCanvasElement, col: number, row: number, cellWidth: number, cellHeight: number, thicknessPx: number, color: number, edge: 'bottom' | 'left'): void {
  const ratio = window.devicePixelRatio || 1;
  const r = ((color >> 16) & 0xff) * INV_255;
  const g = ((color >> 8) & 0xff) * INV_255;
  const b = (color & 0xff) * INV_255;
  const cellX = col * cellWidth * ratio;
  const cellY = row * cellHeight * ratio;
  const cellRight = cellX + cellWidth * ratio;
  const cellBottom = cellY + cellHeight * ratio;
  const x0px = cellX;
  const y0px = edge === 'left' ? cellY : cellBottom - 2 * ratio - thicknessPx;
  const x1px = edge === 'left' ? cellX + thicknessPx : cellRight;
  const y1px = edge === 'left' ? cellBottom : cellBottom - 2 * ratio;
  pushQuad(writer, (x0px / canvas.width) * 2 - 1, 1 - (y0px / canvas.height) * 2, (x1px / canvas.width) * 2 - 1, 1 - (y1px / canvas.height) * 2, r, g, b, 1);
}

function pushPixelRect(writer: FloatWriter, canvas: HTMLCanvasElement, x0px: number, y0px: number, x1px: number, y1px: number, color: number): void {
  if (x1px <= x0px || y1px <= y0px) return;
  const r = ((color >> 16) & 0xff) * INV_255;
  const g = ((color >> 8) & 0xff) * INV_255;
  const b = (color & 0xff) * INV_255;
  pushQuad(writer, (x0px / canvas.width) * 2 - 1, 1 - (y0px / canvas.height) * 2, (x1px / canvas.width) * 2 - 1, 1 - (y1px / canvas.height) * 2, r, g, b, 1);
}

export interface BoxDrawingSegments {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
  style: 'single' | 'double' | 'heavy';
}

export interface BlockElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  alpha: number;
}

const BOX_DRAWING: Record<string, BoxDrawingSegments> = {
  '─': { top: false, right: true, bottom: false, left: true, style: 'single' },
  '│': { top: true, right: false, bottom: true, left: false, style: 'single' },
  '┌': { top: false, right: true, bottom: true, left: false, style: 'single' },
  '┐': { top: false, right: false, bottom: true, left: true, style: 'single' },
  '└': { top: true, right: true, bottom: false, left: false, style: 'single' },
  '┘': { top: true, right: false, bottom: false, left: true, style: 'single' },
  '├': { top: true, right: true, bottom: true, left: false, style: 'single' },
  '┤': { top: true, right: false, bottom: true, left: true, style: 'single' },
  '┬': { top: false, right: true, bottom: true, left: true, style: 'single' },
  '┴': { top: true, right: true, bottom: false, left: true, style: 'single' },
  '┼': { top: true, right: true, bottom: true, left: true, style: 'single' },
  '╭': { top: false, right: true, bottom: true, left: false, style: 'single' },
  '╮': { top: false, right: false, bottom: true, left: true, style: 'single' },
  '╰': { top: true, right: true, bottom: false, left: false, style: 'single' },
  '╯': { top: true, right: false, bottom: false, left: true, style: 'single' },
  '━': { top: false, right: true, bottom: false, left: true, style: 'heavy' },
  '┃': { top: true, right: false, bottom: true, left: false, style: 'heavy' },
  '┏': { top: false, right: true, bottom: true, left: false, style: 'heavy' },
  '┓': { top: false, right: false, bottom: true, left: true, style: 'heavy' },
  '┗': { top: true, right: true, bottom: false, left: false, style: 'heavy' },
  '┛': { top: true, right: false, bottom: false, left: true, style: 'heavy' },
  '┣': { top: true, right: true, bottom: true, left: false, style: 'heavy' },
  '┫': { top: true, right: false, bottom: true, left: true, style: 'heavy' },
  '┳': { top: false, right: true, bottom: true, left: true, style: 'heavy' },
  '┻': { top: true, right: true, bottom: false, left: true, style: 'heavy' },
  '╋': { top: true, right: true, bottom: true, left: true, style: 'heavy' },
  '═': { top: false, right: true, bottom: false, left: true, style: 'double' },
  '║': { top: true, right: false, bottom: true, left: false, style: 'double' },
  '╔': { top: false, right: true, bottom: true, left: false, style: 'double' },
  '╗': { top: false, right: false, bottom: true, left: true, style: 'double' },
  '╚': { top: true, right: true, bottom: false, left: false, style: 'double' },
  '╝': { top: true, right: false, bottom: false, left: true, style: 'double' },
  '╠': { top: true, right: true, bottom: true, left: false, style: 'double' },
  '╣': { top: true, right: false, bottom: true, left: true, style: 'double' },
  '╦': { top: false, right: true, bottom: true, left: true, style: 'double' },
  '╩': { top: true, right: true, bottom: false, left: true, style: 'double' },
  '╬': { top: true, right: true, bottom: true, left: true, style: 'double' }
};

function pushBoxDrawing(writer: FloatWriter, canvas: HTMLCanvasElement, col: number, row: number, cellWidth: number, cellHeight: number, char: string, color: number): void {
  const segments = boxDrawingSegments(char);
  if (!segments) return;
  const ratio = window.devicePixelRatio || 1;
  const x0 = col * cellWidth * ratio;
  const y0 = row * cellHeight * ratio;
  const x1 = x0 + cellWidth * ratio;
  const y1 = y0 + cellHeight * ratio;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const thickness = Math.max(1, (segments.style === 'heavy' ? 2 : 1) * ratio);
  const offset = Math.max(1, 2 * ratio);

  if (segments.style === 'double') {
    if (segments.left) pushDoubleHorizontal(writer, canvas, x0, cx + offset, cy, thickness, offset, color);
    if (segments.right) pushDoubleHorizontal(writer, canvas, cx - offset, x1, cy, thickness, offset, color);
    if (segments.top) pushDoubleVertical(writer, canvas, cx, y0, cy + offset, thickness, offset, color);
    if (segments.bottom) pushDoubleVertical(writer, canvas, cx, cy - offset, y1, thickness, offset, color);
    return;
  }

  if (segments.left) pushPixelRect(writer, canvas, x0, cy - thickness / 2, cx, cy + thickness / 2, color);
  if (segments.right) pushPixelRect(writer, canvas, cx, cy - thickness / 2, x1, cy + thickness / 2, color);
  if (segments.top) pushPixelRect(writer, canvas, cx - thickness / 2, y0, cx + thickness / 2, cy, color);
  if (segments.bottom) pushPixelRect(writer, canvas, cx - thickness / 2, cy, cx + thickness / 2, y1, color);
}

function pushDoubleHorizontal(writer: FloatWriter, canvas: HTMLCanvasElement, x0: number, x1: number, cy: number, thickness: number, offset: number, color: number): void {
  pushPixelRect(writer, canvas, x0, cy - offset - thickness / 2, x1, cy - offset + thickness / 2, color);
  pushPixelRect(writer, canvas, x0, cy + offset - thickness / 2, x1, cy + offset + thickness / 2, color);
}

function pushDoubleVertical(writer: FloatWriter, canvas: HTMLCanvasElement, cx: number, y0: number, y1: number, thickness: number, offset: number, color: number): void {
  pushPixelRect(writer, canvas, cx - offset - thickness / 2, y0, cx - offset + thickness / 2, y1, color);
  pushPixelRect(writer, canvas, cx + offset - thickness / 2, y0, cx + offset + thickness / 2, y1, color);
}

function boxDrawingSegments(char: string): BoxDrawingSegments | null {
  return BOX_DRAWING[char] ?? null;
}

function isDrawableBoxCharacter(char: string): boolean {
  return boxDrawingSegments(char) !== null;
}

function isWideSpacerCell(cell: TerminalCell): boolean {
  return (cell.flags & (FLAG_WIDE_CHAR_SPACER | FLAG_LEADING_WIDE_CHAR_SPACER)) !== 0;
}

function pushBlockElement(writer: FloatWriter, canvas: HTMLCanvasElement, col: number, row: number, cellWidth: number, cellHeight: number, char: string, color: number): void {
  const rects = blockElementRects(char);
  if (rects.length === 0) return;
  const ratio = window.devicePixelRatio || 1;
  const cellX = col * cellWidth * ratio;
  const cellY = row * cellHeight * ratio;
  const pixelWidth = cellWidth * ratio;
  const pixelHeight = cellHeight * ratio;
  const r = ((color >> 16) & 0xff) * INV_255;
  const g = ((color >> 8) & 0xff) * INV_255;
  const b = (color & 0xff) * INV_255;

  for (const rect of rects) {
    const x0 = cellX + rect.x * pixelWidth;
    const y0 = cellY + rect.y * pixelHeight;
    const x1 = x0 + rect.width * pixelWidth;
    const y1 = y0 + rect.height * pixelHeight;
    if (x1 <= x0 || y1 <= y0) continue;
    pushQuad(writer, (x0 / canvas.width) * 2 - 1, 1 - (y0 / canvas.height) * 2, (x1 / canvas.width) * 2 - 1, 1 - (y1 / canvas.height) * 2, r, g, b, rect.alpha);
  }
}

function isDrawableBlockElement(char: string): boolean {
  return blockElementRects(char).length > 0;
}

function blockElementRects(char: string): BlockElementRect[] {
  switch (char) {
    case '█':
      return [blockRect(0, 0, 1, 1)];
    case '▀':
      return [blockRect(0, 0, 1, 0.5)];
    case '▄':
      return [blockRect(0, 0.5, 1, 0.5)];
    case '▔':
      return [blockRect(0, 0, 1, 1 / 8)];
    case '▕':
      return [blockRect(7 / 8, 0, 1 / 8, 1)];
    case '░':
      return [blockRect(0, 0, 1, 1, 0.25)];
    case '▒':
      return [blockRect(0, 0, 1, 1, 0.5)];
    case '▓':
      return [blockRect(0, 0, 1, 1, 0.75)];
    case '▁':
    case '▂':
    case '▃':
    case '▅':
    case '▆':
    case '▇': {
      const eighths = (char.codePointAt(0) ?? 0x2580) - 0x2580;
      const height = eighths / 8;
      return [blockRect(0, 1 - height, 1, height)];
    }
    case '▉':
    case '▊':
    case '▋':
    case '▌':
    case '▍':
    case '▎':
    case '▏': {
      const eighths = 0x2590 - (char.codePointAt(0) ?? 0x2590);
      const width = eighths / 8;
      return [blockRect(0, 0, width, 1)];
    }
    case '▐':
      return [blockRect(0.5, 0, 0.5, 1)];
    case '▖':
      return [blockRect(0, 0.5, 0.5, 0.5)];
    case '▗':
      return [blockRect(0.5, 0.5, 0.5, 0.5)];
    case '▘':
      return [blockRect(0, 0, 0.5, 0.5)];
    case '▙':
      return [blockRect(0, 0, 0.5, 1), blockRect(0.5, 0.5, 0.5, 0.5)];
    case '▚':
      return [blockRect(0, 0, 0.5, 0.5), blockRect(0.5, 0.5, 0.5, 0.5)];
    case '▛':
      return [blockRect(0, 0, 1, 0.5), blockRect(0, 0.5, 0.5, 0.5)];
    case '▜':
      return [blockRect(0, 0, 1, 0.5), blockRect(0.5, 0.5, 0.5, 0.5)];
    case '▝':
      return [blockRect(0.5, 0, 0.5, 0.5)];
    case '▞':
      return [blockRect(0.5, 0, 0.5, 0.5), blockRect(0, 0.5, 0.5, 0.5)];
    case '▟':
      return [blockRect(0.5, 0, 0.5, 1), blockRect(0, 0.5, 0.5, 0.5)];
    default:
      return [];
  }
}

function blockRect(x: number, y: number, width: number, height: number, alpha = 1): BlockElementRect {
  return { x, y, width, height, alpha };
}

function shouldSkipGlyph(cell: TerminalCell): boolean {
  return cell.char === ' ' || (cell.flags & FLAG_HIDDEN) !== 0 || isWideSpacerCell(cell) || isDrawableBoxCharacter(cell.char) || isDrawableBlockElement(cell.char);
}

function pushGlyphQuad(writer: FloatWriter, canvas: HTMLCanvasElement, atlas: GlyphAtlas, col: number, row: number, cellWidth: number, cellHeight: number, char: string, color: number, flags: number): void {
  const entry = ensureGlyph(atlas, char, flags);
  if (!entry) return;
  const invAtlasW = 1 / atlas.canvas.width;
  const invAtlasH = 1 / atlas.canvas.height;
  const u0 = (entry.col * atlas.slotWidth + atlas.padding) * invAtlasW;
  const v0 = (entry.row * atlas.slotHeight + atlas.padding) * invAtlasH;
  const u1 = (entry.col * atlas.slotWidth + atlas.padding + atlasGlyphWidth(atlas, entry)) * invAtlasW;
  const v1 = (entry.row * atlas.slotHeight + atlas.padding + atlas.glyphHeight) * invAtlasH;
  const r = entry.color ? 1 : ((color >> 16) & 0xff) * INV_255;
  const g = entry.color ? 1 : ((color >> 8) & 0xff) * INV_255;
  const b = entry.color ? 1 : (color & 0xff) * INV_255;
  const alpha = (flags & FLAG_DIM) !== 0 ? 0.65 : 1;
  const width = (flags & FLAG_WIDE_CHAR) !== 0 ? cellWidth * 2 : cellWidth;
  const ratio = window.devicePixelRatio || 1;
  const x0px = col * cellWidth * ratio - atlas.overdrawX;
  const y0px = row * cellHeight * ratio - atlas.overdrawY;
  const x1px = x0px + width * ratio + atlas.overdrawX * 2;
  const y1px = y0px + cellHeight * ratio + atlas.overdrawY * 2;
  const invW = 2 / canvas.width;
  const invH = 2 / canvas.height;
  const x0 = x0px * invW - 1;
  const y0 = 1 - y0px * invH;
  const x1 = x1px * invW - 1;
  const y1 = 1 - y1px * invH;

  writer.ensure(48);
  const out = writer.data;
  let i = writer.length;
  out[i++] = x0; out[i++] = y0; out[i++] = u0; out[i++] = v0; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = alpha;
  out[i++] = x1; out[i++] = y0; out[i++] = u1; out[i++] = v0; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = alpha;
  out[i++] = x0; out[i++] = y1; out[i++] = u0; out[i++] = v1; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = alpha;
  out[i++] = x0; out[i++] = y1; out[i++] = u0; out[i++] = v1; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = alpha;
  out[i++] = x1; out[i++] = y0; out[i++] = u1; out[i++] = v0; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = alpha;
  out[i++] = x1; out[i++] = y1; out[i++] = u1; out[i++] = v1; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = alpha;
  writer.length = i;
}

function ensureGlyph(atlas: GlyphAtlas, char: string, flags: number): GlyphAtlasEntry | null {
  const codepoint = char.codePointAt(0);
  if (!codepoint) return null;
  const variant = glyphVariantIndex(flags);
  const key = glyphKey(codepoint, variant);
  const existing = atlas.glyphs.get(key);
  if (existing) return existing;
  const wide = (flags & FLAG_WIDE_CHAR) !== 0;
  const index = allocateAtlasSlots(atlas, wide ? 2 : 1);
  if (index === null) {
    atlas.overflowed = true;
    return null;
  }

  const entry: GlyphAtlasEntry = {
    col: index % atlas.cols,
    row: Math.floor(index / atlas.cols),
    wide
  };
  atlas.glyphs.set(key, entry);
  drawGlyphIntoAtlas(atlas, char, flags, entry);
  const x = entry.col * atlas.slotWidth;
  const y = entry.row * atlas.slotHeight;
  const previous = atlas.dirty;
  atlas.dirty = { x: Math.min(previous?.x ?? x, x), y: Math.min(previous?.y ?? y, y), right: Math.max(previous?.right ?? 0, x + atlasSlotSpan(entry) * atlas.slotWidth), bottom: Math.max(previous?.bottom ?? 0, y + atlas.slotHeight) };
  return entry;
}

function atlasSlotSpan(entry: GlyphAtlasEntry): number {
  return entry.wide ? 2 : 1;
}

function atlasGlyphWidth(atlas: Pick<GlyphAtlasMetrics, 'glyphWidth' | 'overdrawX'>, entry: GlyphAtlasEntry): number {
  // A wide glyph covers one extra cell, which fits inside the second slot.
  return entry.wide ? atlas.glyphWidth * 2 - atlas.overdrawX * 2 : atlas.glyphWidth;
}

function allocateAtlasSlots(atlas: GlyphAtlas, span: number): number | null {
  if (span === 1) {
    if (atlas.freeSlots.length > 0) return atlas.freeSlots.pop()!;
    return atlas.nextIndex < atlas.capacity ? atlas.nextIndex++ : null;
  }
  const free = new Set(atlas.freeSlots);
  for (const index of atlas.freeSlots) {
    if (index % atlas.cols < atlas.cols - 1 && free.has(index + 1)) {
      atlas.freeSlots = atlas.freeSlots.filter((slot) => slot !== index && slot !== index + 1);
      return index;
    }
  }
  // Wide glyphs cannot wrap across atlas rows; keep a row's last slot for narrow glyphs.
  if (atlas.nextIndex % atlas.cols === atlas.cols - 1 && atlas.nextIndex < atlas.capacity) atlas.freeSlots.push(atlas.nextIndex++);
  if (atlas.nextIndex + 1 >= atlas.capacity) return null;
  const index = atlas.nextIndex;
  atlas.nextIndex += 2;
  return index;
}

function prepareAtlasForState(atlas: GlyphAtlas, state: TerminalRenderState, damagedRows?: Set<number>): boolean {
  if (atlas.glyphs.size === 0 || damagedRows?.size === 0) return false;
  const missing = new Set<number>();
  let missingSlots = 0;
  for (const row of (atlas.overflowed ? undefined : damagedRows) ?? Array.from({ length: state.rows }, (_, row) => row)) {
    for (let col = 0; col < state.cols; col += 1) {
      const cell = state.cells[row]?.[col];
      if (!cell || shouldSkipGlyph(cell)) continue;
      const key = glyphKey(cell.char.codePointAt(0) ?? 0, glyphVariantIndex(cell.flags));
      if (atlas.glyphs.has(key) || missing.has(key)) continue;
      missing.add(key);
      missingSlots += (cell.flags & FLAG_WIDE_CHAR) !== 0 ? 2 : 1;
    }
  }
  if (atlas.nextIndex - atlas.freeSlots.length + missingSlots <= atlas.capacity) return false;

  // Retain the first capacity worth of distinct glyphs in screen order, as a
  // fresh atlas does. Keep their UVs stable instead of clearing the whole atlas.
  const visible = new Set<number>();
  let visibleSlots = 0;
  visibleRows: for (let row = 0; row < state.rows; row += 1) {
    for (let col = 0; col < state.cols; col += 1) {
      const cell = state.cells[row]?.[col];
      if (!cell || shouldSkipGlyph(cell)) continue;
      const key = glyphKey(cell.char.codePointAt(0) ?? 0, glyphVariantIndex(cell.flags));
      if (visible.has(key)) continue;
      visible.add(key);
      visibleSlots += (cell.flags & FLAG_WIDE_CHAR) !== 0 ? 2 : 1;
      if (visibleSlots >= atlas.capacity) break visibleRows;
    }
  }
  let reclaimed = false;
  for (const [key, entry] of atlas.glyphs) {
    if (visible.has(key)) continue;
    atlas.glyphs.delete(key);
    const index = entry.row * atlas.cols + entry.col;
    atlas.freeSlots.push(index);
    if (entry.wide) atlas.freeSlots.push(index + 1);
    reclaimed = true;
  }
  if (reclaimed) {
    atlas.overflowed = false;
    atlas.generation += 1;
  }
  return reclaimed;
}

function glyphKey(codepoint: number, variant: number): number {
  // Each Unicode code point has eight bold/italic/wide variants.
  return codepoint * 8 + variant;
}

function drawGlyphIntoAtlas(atlas: GlyphAtlas, char: string, flags: number, entry: GlyphAtlasEntry): void {
  const ratio = window.devicePixelRatio || 1;
  const x = entry.col * atlas.slotWidth;
  const y = entry.row * atlas.slotHeight;
  const width = atlasSlotSpan(entry) * atlas.slotWidth;
  atlas.context.clearRect(x, y, width, atlas.slotHeight);
  atlas.context.fillStyle = '#ffffff';
  atlas.context.textBaseline = 'top';
  atlas.context.font = `${(flags & FLAG_ITALIC) !== 0 ? 'italic ' : ''}${(flags & FLAG_BOLD) !== 0 ? '700 ' : ''}${atlas.fontSize * ratio}px ${atlas.fontFamily}`;
  atlas.context.fillText(char, x + atlas.padding + atlas.overdrawX, y + atlas.padding + atlas.overdrawY + 2 * ratio);
  entry.color = PICTOGRAPHIC_PATTERN.test(char) && hasColorPixels(atlas.context.getImageData(x, y, width, atlas.slotHeight).data);
}

const PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;

function hasColorPixels(data: Uint8ClampedArray): boolean {
  // Monochrome glyphs are drawn white, so any opaque non-white pixel came from a colour font.
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! > 128 && Math.min(data[index]!, data[index + 1]!, data[index + 2]!) < 224) return true;
  }
  return false;
}

function glyphVariantIndex(flags: number): number {
  const italic = (flags & FLAG_ITALIC) !== 0 ? 1 : 0;
  const bold = (flags & FLAG_BOLD) !== 0 ? 2 : 0;
  const wide = (flags & FLAG_WIDE_CHAR) !== 0 ? 4 : 0;
  return italic + bold + wide;
}

function pushQuad(writer: FloatWriter, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void {
  writer.ensure(36);
  const out = writer.data;
  let i = writer.length;
  out[i++] = x0; out[i++] = y0; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = a;
  out[i++] = x1; out[i++] = y0; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = a;
  out[i++] = x0; out[i++] = y1; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = a;
  out[i++] = x0; out[i++] = y1; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = a;
  out[i++] = x1; out[i++] = y0; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = a;
  out[i++] = x1; out[i++] = y1; out[i++] = r; out[i++] = g; out[i++] = b; out[i++] = a;
  writer.length = i;
}

let measureOwnerDocument: Document | null = null;
let measureContext: CanvasRenderingContext2D | null = null;

function measureCellWidth(fontSize: number, fontFamily: string): number {
  if (measureOwnerDocument !== document) {
    measureOwnerDocument = document;
    measureContext = document.createElement('canvas').getContext('2d');
  }
  if (!measureContext) return 9;
  measureContext.font = `${fontSize}px ${fontFamily.trim() || DEFAULT_TERMINAL_FONT_FAMILY}`;
  return measureContext.measureText('W').width || 9;
}

const TERMINAL_BACKGROUND_RGB: [number, number, number] = [
  ((TERMINAL_BACKGROUND_U32 >> 16) & 0xff) * INV_255,
  ((TERMINAL_BACKGROUND_U32 >> 8) & 0xff) * INV_255,
  (TERMINAL_BACKGROUND_U32 & 0xff) * INV_255
];

const NAMED_COLORS: Record<number, number> = {
  0: 0x18181b,
  1: 0xef4444,
  2: 0x22c55e,
  3: 0xeab308,
  4: 0x3b82f6,
  5: 0xd946ef,
  6: 0x06b6d4,
  7: 0xe4e4e7,
  8: 0x71717a,
  9: 0xf87171,
  10: 0x4ade80,
  11: 0xfacc15,
  12: 0x60a5fa,
  13: 0xe879f9,
  14: 0x22d3ee,
  15: TERMINAL_FOREGROUND_U32,
  256: TERMINAL_FOREGROUND_U32,
  257: TERMINAL_BACKGROUND_U32,
  268: TERMINAL_FOREGROUND_U32,
  269: TERMINAL_MUTED_FOREGROUND_U32
};

function colorToU32(color: number | string): number {
  if (typeof color === 'number') return color;
  return Number.parseInt(color.slice(1), 16);
}

function colorU32ToHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

function decodeColorU32(kind: number, value: number, fallback: number): number {
  if (kind === 2) return value & 0xffffff;
  if (kind === 1) return value < 16 ? (NAMED_COLORS[value] ?? fallback) : fallback;
  return NAMED_COLORS[value] ?? fallback;
}
