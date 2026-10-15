import { parseDamageFrame, type ParsedDamageFrame } from './TerminalRenderer';

// Parse each queued frame once and drop everything before the newest
// snapshot. The renderer applies the parsed frames directly. Frames for
// another PTY, such as the one just left, are dropped first, so their
// snapshots can't hide this one's frames.
export function coalesceTerminalFrames(payloads: Uint8Array[], processId: string | null, textDecoder?: TextDecoder): { frames: Array<ParsedDamageFrame | null>; byteLength: number } {
  const parsed = payloads.map((payload) => ({ payload, frame: parseDamageFrame(payload, textDecoder) }))
    .filter(({ frame }) => !frame || frame.processId === processId);
  let latestSnapshotIndex = 0;
  let latestSnapshotSeq = -1;

  for (let index = 0; index < parsed.length; index += 1) {
    const frame = parsed[index]!.frame;
    if (!frame || frame.frameKind !== 'snapshot') continue;
    if (frame.resizeSeq >= latestSnapshotSeq) {
      latestSnapshotSeq = frame.resizeSeq;
      latestSnapshotIndex = index;
    }
  }

  const kept = parsed.slice(latestSnapshotIndex);
  return { frames: kept.map(({ frame }) => frame), byteLength: kept.reduce((total, { payload }) => total + payload.byteLength, 0) };
}
