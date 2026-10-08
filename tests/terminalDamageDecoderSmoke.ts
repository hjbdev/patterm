import assert from 'node:assert/strict';

import {
  backgroundRunsForTest,
  blockElementRectsForTest,
  boxDrawingSegmentsForTest,
  glyphAtlasMetricsForTest,
  glyphAtlasUvForTest,
  glyphQuadWidthCellsForTest,
  isFrameStaleForResizeTarget,
  parseDamageFrame,
  shouldRenderGlyphForTest,
  terminalCellHeightForFontSizeForTest,
  terminalRendererTestFlags
} from '../resources/js/terminal/TerminalRenderer';

type Layout = 'current' | 'shape-only' | 'visible-only' | 'legacy';

function main(): void {
  const snapshot = parseDamageFrame(versionedFrame('snapshot', '🚂'.codePointAt(0) ?? 0x20));
  assert.equal(snapshot?.frameKind, 'snapshot');
  assert.equal(snapshot?.frameSeq, 7);
  assert.equal(snapshot?.epoch, 3);
  assert.equal(snapshot?.resizeSeq, 0);
  assert.equal(snapshot?.runs[0]?.cells[0]?.char, '🚂');

  const emptySnapshot = parseDamageFrame(versionedFrame('snapshot', '🚂'.codePointAt(0) ?? 0x20, 0, false));
  assert.equal(emptySnapshot, null);

  const damage = parseDamageFrame(versionedFrame('damage', 'λ'.codePointAt(0) ?? 0x20));
  assert.equal(damage?.frameKind, 'damage');
  assert.equal(damage?.epoch, 3);
  assert.equal(damage?.runs[0]?.cells[0]?.char, 'λ');

  const sparseDamage = parseDamageFrame(sparseVersionedFrame('S'.codePointAt(0) ?? 0x20));
  assert.equal(sparseDamage?.frameKind, 'damage');
  assert.equal(sparseDamage?.cols, 5);
  assert.equal(sparseDamage?.runs.length, 1);
  assert.equal(sparseDamage?.runs[0]?.row, 1);
  assert.equal(sparseDamage?.runs[0]?.startCol, 3);
  assert.equal(sparseDamage?.runs[0]?.cells.length, 1);
  assert.equal(sparseDamage?.runs[0]?.cells[0]?.char, 'S');

  const currentResize = parseDamageFrame(versionedFrame('snapshot', 'R'.codePointAt(0) ?? 0x20, 12, true, 3, 2));
  const oldResize = parseDamageFrame(versionedFrame('snapshot', 'O'.codePointAt(0) ?? 0x20, 11, true, 3, 2));
  const mismatchedResize = parseDamageFrame(versionedFrame('snapshot', 'M'.codePointAt(0) ?? 0x20, 12, true, 2, 1));
  assert.equal(currentResize ? isFrameStaleForResizeTarget(currentResize, { cols: 3, rows: 2, cellWidth: 9, cellHeight: 18, resizeSeq: 12 }) : true, false);
  assert.equal(oldResize ? isFrameStaleForResizeTarget(oldResize, { cols: 3, rows: 2, cellWidth: 9, cellHeight: 18, resizeSeq: 12 }) : false, true);
  assert.equal(mismatchedResize ? isFrameStaleForResizeTarget(mismatchedResize, { cols: 3, rows: 2, cellWidth: 9, cellHeight: 18, resizeSeq: 12 }) : false, true);

  const current = parseDamageFrame(frame('current', '🚂'.codePointAt(0) ?? 0x20, 1, 2));
  assert.equal(current?.processId, 'proc_test');
  assert.equal(current?.resizeSeq, 42);
  assert.equal(current?.cursor.visible, true);
  assert.equal(current?.cursor.shape, 'underline');
  assert.equal(current?.runs[0]?.cells[0]?.char, '🚂');

  const shapeOnly = parseDamageFrame(frame('shape-only', 'Ω'.codePointAt(0) ?? 0x20, 1, 1));
  assert.equal(shapeOnly?.resizeSeq, 0);
  assert.equal(shapeOnly?.cursor.shape, 'beam');
  assert.equal(shapeOnly?.runs[0]?.cells[0]?.char, 'Ω');

  const visibleOnly = parseDamageFrame(frame('visible-only', 'λ'.codePointAt(0) ?? 0x20, 0));
  assert.equal(visibleOnly?.cursor.visible, false);
  assert.equal(visibleOnly?.cursor.shape, 'hidden');
  assert.equal(visibleOnly?.runs[0]?.cells[0]?.char, 'λ');

  const legacy = parseDamageFrame(frame('legacy', 0x41));
  assert.equal(legacy?.cursor.visible, true);
  assert.equal(legacy?.resizeSeq, 0);
  assert.equal(legacy?.cursor.shape, 'block');
  assert.equal(legacy?.runs[0]?.cells[0]?.char, 'A');

  const invalidCodepoint = parseDamageFrame(frame('current', 0x20_0000, 1, 1));
  assert.equal(invalidCodepoint?.runs[0]?.cells[0]?.char, '\uFFFD');

  const malformed = parseDamageFrame(new Uint8Array([1, 0, 1]));
  assert.equal(malformed, null);

  assert.equal(shouldRenderGlyphForTest({ char: 'A', flags: 0, fg: '#ffffff', bg: '#000000' }), true);
  assert.equal(shouldRenderGlyphForTest({ char: '┌', flags: 0, fg: '#ffffff', bg: '#000000' }), false, 'box drawing uses geometry, not atlas glyphs');
  assert.equal(shouldRenderGlyphForTest({ char: '█', flags: 0, fg: '#ffffff', bg: '#000000' }), false, 'block elements use geometry, not atlas glyphs');
  assert.equal(
    shouldRenderGlyphForTest({ char: ' ', flags: terminalRendererTestFlags.wideCharSpacer, fg: '#ffffff', bg: '#000000' }),
    false,
    'wide trailing spacer does not draw a glyph'
  );
  assert.equal(glyphQuadWidthCellsForTest(terminalRendererTestFlags.wideChar), 2, 'wide leading cell draws across two columns');
  assert.deepEqual(
    backgroundRunsForTest([[cellWithBackground('#111111'), cellWithBackground('#111111'), cellWithBackground('#151515'), cellWithBackground('#222222'), cellWithBackground('#222222'), cellWithBackground('#111111')]]),
    [
      { row: 0, startCol: 0, colCount: 2, color: '#111111' },
      { row: 0, startCol: 3, colCount: 2, color: '#222222' },
      { row: 0, startCol: 5, colCount: 1, color: '#111111' }
    ],
    'adjacent same-color backgrounds are merged into draw runs'
  );

  const corner = boxDrawingSegmentsForTest('┌');
  assert.deepEqual(corner, { top: false, right: true, bottom: true, left: false, style: 'single' });
  const doubleCross = boxDrawingSegmentsForTest('╬');
  assert.deepEqual(doubleCross, { top: true, right: true, bottom: true, left: true, style: 'double' });

  assert.deepEqual(blockElementRectsForTest('█'), [{ x: 0, y: 0, width: 1, height: 1, alpha: 1 }]);
  assert.deepEqual(blockElementRectsForTest('▀'), [{ x: 0, y: 0, width: 1, height: 0.5, alpha: 1 }]);
  assert.deepEqual(blockElementRectsForTest('▄'), [{ x: 0, y: 0.5, width: 1, height: 0.5, alpha: 1 }]);
  assert.deepEqual(blockElementRectsForTest('▃'), [{ x: 0, y: 0.625, width: 1, height: 0.375, alpha: 1 }]);
  assert.deepEqual(blockElementRectsForTest('▌'), [{ x: 0, y: 0, width: 0.5, height: 1, alpha: 1 }]);
  assert.deepEqual(blockElementRectsForTest('▐'), [{ x: 0.5, y: 0, width: 0.5, height: 1, alpha: 1 }]);
  assert.deepEqual(blockElementRectsForTest('▟'), [
    { x: 0.5, y: 0, width: 0.5, height: 1, alpha: 1 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5, alpha: 1 }
  ]);
  assert.deepEqual(blockElementRectsForTest('▒'), [{ x: 0, y: 0, width: 1, height: 1, alpha: 0.5 }]);
  for (const char of '▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟') {
    assert.ok(blockElementRectsForTest(char).length > 0, `${char} has block geometry`);
    assert.equal(shouldRenderGlyphForTest({ char, flags: 0, fg: '#ffffff', bg: '#000000' }), false, `${char} does not render through the glyph atlas`);
  }

  const atlas = glyphAtlasMetricsForTest(4096, 9, 18, 2);
  assert.equal(atlas.overdrawX, 6);
  assert.equal(atlas.overdrawY, 4);
  assert.equal(atlas.glyphWidth, 18 + atlas.overdrawX * 2);
  assert.equal(atlas.glyphHeight, 36 + atlas.overdrawY * 2);
  assert.ok(atlas.padding >= 4, 'atlas entries include a transparent gutter');
  assert.equal(atlas.slotWidth, atlas.glyphWidth + atlas.padding * 2);
  assert.equal(atlas.slotHeight, atlas.glyphHeight + atlas.padding * 2);
  const firstUv = glyphAtlasUvForTest(atlas, { col: 0, row: 0 });
  assert.ok(firstUv.u0 > 0 && firstUv.v0 > 0, 'first glyph UV starts after the padded atlas edge');
  const uv = glyphAtlasUvForTest(atlas, { col: 1, row: 1 });
  const slotU0 = atlas.slotWidth / (atlas.cols * atlas.slotWidth);
  const slotV0 = atlas.slotHeight / (atlas.rows * atlas.slotHeight);
  const slotU1 = (atlas.slotWidth * 2) / (atlas.cols * atlas.slotWidth);
  const slotV1 = (atlas.slotHeight * 2) / (atlas.rows * atlas.slotHeight);
  assert.ok(uv.u0 > slotU0 && uv.v0 > slotV0, 'glyph UV starts inside padded slot');
  assert.ok(uv.u1 < slotU1 && uv.v1 < slotV1, 'glyph UV ends inside padded slot');
  const wideUv = glyphAtlasUvForTest(atlas, { col: 1, row: 1, wide: true });
  const cellU = 18 / (atlas.cols * atlas.slotWidth);
  assert.ok(Math.abs(wideUv.u1 - uv.u1 - cellU) < 1e-9, 'wide glyph UV spans one extra cell');
  assert.ok(wideUv.u1 < (atlas.slotWidth * 3) / (atlas.cols * atlas.slotWidth), 'wide glyph UV ends inside its second slot');

  assert.equal(terminalCellHeightForFontSizeForTest(14), 18);
  assert.equal(terminalCellHeightForFontSizeForTest(16), 21);
  const zoomedAtlas = glyphAtlasMetricsForTest(4096, 11, terminalCellHeightForFontSizeForTest(16), 2);
  assert.ok(zoomedAtlas.glyphHeight > atlas.glyphHeight, 'larger font cell metrics produce a larger glyph atlas slot');
}

function versionedFrame(kind: 'snapshot' | 'damage', codepoint: number, resizeSeq = 0, includeRuns = true, cols = 2, rows = 1): Uint8Array {
  const bytes: number[] = [];
  const processId = Buffer.from('proc_test');
  pushU16(bytes, 2);
  bytes.push(kind === 'snapshot' ? 0 : 1);
  pushU32(bytes, 7);
  pushU32(bytes, 3);
  pushU32(bytes, resizeSeq);
  pushU16(bytes, processId.length);
  bytes.push(...processId);
  pushU16(bytes, cols);
  pushU16(bytes, rows);
  pushU16(bytes, 0);
  pushU16(bytes, 0);
  bytes.push(1);
  bytes.push(0);
  pushU16(bytes, includeRuns ? rows : 0);
  if (includeRuns) {
    for (let row = 0; row < rows; row += 1) {
      pushU16(bytes, row);
      pushU16(bytes, 0);
      pushU16(bytes, cols);
      for (let col = 0; col < cols; col += 1) {
        pushCell(bytes, row === 0 && col === 0 ? codepoint : 0x20);
      }
    }
  }
  return Uint8Array.from(bytes);
}

function sparseVersionedFrame(codepoint: number): Uint8Array {
  const bytes: number[] = [];
  const processId = Buffer.from('proc_test');
  pushU16(bytes, 2);
  bytes.push(1);
  pushU32(bytes, 8);
  pushU32(bytes, 3);
  pushU32(bytes, 0);
  pushU16(bytes, processId.length);
  bytes.push(...processId);
  pushU16(bytes, 5);
  pushU16(bytes, 2);
  pushU16(bytes, 3);
  pushU16(bytes, 1);
  bytes.push(1);
  bytes.push(0);
  pushU16(bytes, 1);
  pushU16(bytes, 1);
  pushU16(bytes, 3);
  pushU16(bytes, 1);
  pushCell(bytes, codepoint);
  return Uint8Array.from(bytes);
}

function frame(layout: Layout, codepoint: number, visible = 1, shape = 0): Uint8Array {
  const bytes: number[] = [];
  const processId = Buffer.from('proc_test');
  pushU16(bytes, processId.length);
  bytes.push(...processId);
  pushU16(bytes, 2);
  pushU16(bytes, 1);
  pushU16(bytes, 0);
  pushU16(bytes, 0);
  if (layout !== 'legacy') bytes.push(visible);
  if (layout === 'shape-only' || layout === 'current') bytes.push(shape);
  if (layout === 'current') pushU32(bytes, 42);
  pushU16(bytes, 1);
  pushU16(bytes, 0);
  pushU16(bytes, 0);
  pushU16(bytes, 1);
  pushU32(bytes, codepoint);
  pushU16(bytes, 0);
  bytes.push(0);
  pushU32(bytes, 256);
  bytes.push(0);
  pushU32(bytes, 257);
  return Uint8Array.from(bytes);
}

function cellWithBackground(bg: string) {
  return { char: ' ', flags: 0, fg: '#ffffff', bg };
}

function pushU16(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function pushU32(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function pushCell(bytes: number[], codepoint: number): void {
  pushU32(bytes, codepoint);
  pushU16(bytes, 0);
  bytes.push(0);
  pushU32(bytes, 256);
  bytes.push(0);
  pushU32(bytes, 257);
}

main();
