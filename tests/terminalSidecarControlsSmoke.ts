import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DebugLogService } from '../app/Services/DebugLogService';
import { TerminalService } from '../app/Services/TerminalService';
import { parseDamageFrame } from '../resources/js/terminal/TerminalRenderer';
import { debugSidecarPath } from './fixtures/Sidecar';

interface SpawnResult {
  process_id: string;
}

interface OutputResult {
  process_id: string;
  status: string;
  cols: number;
  rows: number;
  display_offset: number;
  mouse?: { click?: boolean; drag?: boolean; motion?: boolean; sgr?: boolean };
  screen: string;
  lines: string[];
}

interface SearchResult {
  matches: Array<{ row: number; col: number; length: number }>;
}

interface SelectionResult {
  text: string;
}

interface StopResult {
  ok: boolean;
  status: string;
}

interface MouseResult {
  ok: boolean;
  reported: boolean;
}

interface LifecycleFrame {
  processId: string;
  event: string;
  activity?: string;
  at: number;
}

async function main(): Promise<void> {
  const sidecarPath = debugSidecarPath();
  assert.equal(fs.existsSync(sidecarPath), true, 'terminal sidecar must be built before running this smoke test');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-terminal-sidecar-'));
  const debugLog = new DebugLogService(tempDir);
  debugLog.initialize();
  const terminal = new TerminalService(sidecarPath, debugLog);

  try {
    await terminal.start();
    assert.equal(terminal.isAvailable(), true, 'sidecar should start');

    const damageFrames: Array<{ processId: string | null; frameKind: string | null; payload: Uint8Array }> = [];
    const lifecycleFrames: LifecycleFrame[] = [];
    const unsubscribeFrames = terminal.onFrame((frame) => {
      if (frame.type === 'terminal-damage') {
        damageFrames.push({ processId: frame.processId, frameKind: frame.frameKind, payload: frame.payload });
      }
      if (frame.type === 'terminal-lifecycle') {
        lifecycleFrames.push({
          processId: frame.processId,
          event: frame.event,
          at: Date.now(),
          ...(frame.activity ? { activity: frame.activity } : {})
        });
      }
    });

    const subscriptionSpawn = await terminal.request('terminal.process.spawn', {
      name: 'subscription-smoke',
      ...script("printf 'subscription-ready\\n'; sleep 3", [{ out: 'subscription-ready\r\n' }, { sleep: 3000 }]),
      cols: 30,
      rows: 3,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;

    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: subscriptionSpawn.process_id }) as OutputResult;
      return output.screen.includes('subscription-ready');
    }, 'terminal output remains readable while damage frames are unsubscribed');
    assert.equal(damageFrames.length, 0, 'unsubscribed terminals do not emit damage frames');
    await waitFor(async () => hasActivity(lifecycleFrames, subscriptionSpawn.process_id, 'working'), 'unsubscribed PTY output emits working activity');
    await waitFor(async () => hasActivity(lifecycleFrames, subscriptionSpawn.process_id, 'idle'), 'unsubscribed PTY output settles back to idle');

    const noisySpawn = await terminal.request('terminal.process.spawn', {
      name: 'activity-noisy-smoke',
      ...script("i=0; while [ \"$i\" -lt 8 ]; do printf 'tick%s\\n' \"$i\"; i=$((i + 1)); sleep 0.4; done; sleep 1", [{ ticks: 8, every: 400 }, { sleep: 1000 }]),
      cols: 30,
      rows: 3,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitFor(async () => hasActivity(lifecycleFrames, noisySpawn.process_id, 'working'), 'noisy PTY output emits working activity');
    const noisyStartedAt = firstActivityAt(lifecycleFrames, noisySpawn.process_id, 'working') ?? Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(
      lifecycleFrames.some((frame) => frame.processId === noisySpawn.process_id && frame.activity === 'idle' && frame.at > noisyStartedAt),
      false,
      'continuous PTY output does not become idle before the output quiets down'
    );
    await waitFor(async () => hasActivity(lifecycleFrames, noisySpawn.process_id, 'idle'), 'noisy PTY output settles back to idle after the last output');

    await terminal.request('terminal.process.subscribe', { process_id: subscriptionSpawn.process_id, subscribed: true });
    await waitFor(async () => damageFrames.some((frame) => frame.processId === subscriptionSpawn.process_id && frame.frameKind === 'snapshot'), 'subscribing emits a fresh snapshot frame');
    const frameCountAfterSubscribe = damageFrames.length;
    await terminal.request('terminal.process.subscribe', { process_id: subscriptionSpawn.process_id, subscribed: false });
    await terminal.request('terminal.process.refresh', { process_id: subscriptionSpawn.process_id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(damageFrames.length, frameCountAfterSubscribe, 'refresh while unsubscribed does not emit damage frames');

    const linkUrl = 'https://example.com/pull/85';
    const linkSpawn = await terminal.request('terminal.process.spawn', {
      name: 'hyperlink-smoke',
      ...script("printf 'PR \\033]8;;https://example.com/pull/85\\007\\033[4m#85\\033[0m\\033]8;;\\007'; sleep 1", [{ out: 'PR \x1b]8;;https://example.com/pull/85\x07\x1b[4m#85\x1b[0m\x1b]8;;\x07' }, { sleep: 1000 }]),
      cols: 20,
      rows: 2
    }) as SpawnResult;
    await terminal.request('terminal.process.subscribe', { process_id: linkSpawn.process_id, subscribed: true });
    await waitFor(async () => damageFrames.some((frame) => {
      if (frame.processId !== linkSpawn.process_id) return false;
      const cells = parseDamageFrame(frame.payload)?.runs.flatMap((run) => run.cells) ?? [];
      return cells.filter((cell) => cell.hyperlink === linkUrl).map((cell) => cell.char).join('') === '#85';
    }), 'OSC 8 labels retain their destination through the sidecar, service metadata decoder, and renderer decoder');
    await terminal.request('terminal.process.close', { process_id: linkSpawn.process_id });

    const quietSpawn = await terminal.request('terminal.process.spawn', {
      name: 'quiet-subscription-smoke',
      ...script('sleep 1', [{ sleep: process.platform === 'win32' ? 5000 : 1000 }]),
      cols: 20,
      rows: 2,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    // ConPTY paints its own startup output, so let that settle before counting.
    if (process.platform === 'win32') await waitFor(async () => hasActivity(lifecycleFrames, quietSpawn.process_id, 'idle'), 'ConPTY startup output settles');
    const quietActivityCount = lifecycleFrames.filter((frame) => frame.processId === quietSpawn.process_id && frame.event === 'activity').length;
    await terminal.request('terminal.process.subscribe', { process_id: quietSpawn.process_id, subscribed: true });
    await waitFor(async () => damageFrames.some((frame) => frame.processId === quietSpawn.process_id && frame.frameKind === 'snapshot'), 'subscribing a quiet terminal emits a snapshot frame');
    await terminal.request('terminal.process.refresh', { process_id: quietSpawn.process_id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      lifecycleFrames.filter((frame) => frame.processId === quietSpawn.process_id && frame.event === 'activity').length,
      quietActivityCount,
      'subscribe/refresh does not mark a quiet terminal as working'
    );
    await terminal.request('terminal.process.subscribe', { process_id: quietSpawn.process_id, subscribed: false });

    const sparseSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sparse-damage-smoke',
      ...script("sleep 0.2; printf 'abc'; sleep 0.2; printf '\\rZ'; sleep 1", [{ sleep: 200 }, { out: 'abc' }, { sleep: 200 }, { out: '\rZ' }, { sleep: 1000 }]),
      cols: 20,
      rows: 2,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await terminal.request('terminal.process.subscribe', { process_id: sparseSpawn.process_id, subscribed: true });
    await waitFor(async () => damageFrames.some((frame) => frame.processId === sparseSpawn.process_id && frame.frameKind === 'snapshot'), 'sparse smoke emits an initial snapshot');
    await waitFor(async () => {
      return damageFrames.some((frame) => {
        if (frame.processId !== sparseSpawn.process_id || frame.frameKind !== 'damage') return false;
        const parsed = parseDamageFrame(frame.payload);
        return Boolean(parsed && parsed.runs.length > 0 && parsed.runs.every((run) => run.cells.length < parsed.cols));
      });
    }, 'localized terminal output emits sparse damage runs');
    await terminal.request('terminal.process.subscribe', { process_id: sparseSpawn.process_id, subscribed: false });
    unsubscribeFrames();

    const spawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-smoke',
      ...script("printf 'line01\\nline02\\nline03\\nline04\\nline05\\nline06\\nline07\\nline08\\n'; sleep 1", [{ out: 'line01\r\nline02\r\nline03\r\nline04\r\nline05\r\nline06\r\nline07\r\nline08\r\n' }, { sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;

    const configured = await terminal.request('terminal.process.configure', {
      process_id: spawn.process_id,
      target_frame_interval_ms: 4.2
    }) as { ok: boolean; target_frame_interval_ms: number };
    assert.equal(configured.ok, true, 'terminal frame interval configuration succeeds');
    assert.ok(configured.target_frame_interval_ms <= 5, 'high-refresh frame interval is not clamped to 60fps');

    const lowFpsConfigured = await terminal.request('terminal.process.configure', {
      process_id: spawn.process_id,
      target_frame_interval_ms: 100
    }) as { ok: boolean; target_frame_interval_ms: number };
    assert.equal(lowFpsConfigured.ok, true, 'low-fps terminal frame interval configuration succeeds');
    assert.equal(lowFpsConfigured.target_frame_interval_ms, 100, 'visible unfocused cadence is not clamped to foreground fps');

    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: spawn.process_id }) as OutputResult;
      return output.screen.includes('line08');
    }, 'terminal output should include the last printed line');

    const bottom = await terminal.request('terminal.process.output', { process_id: spawn.process_id }) as OutputResult;
    assert.equal(bottom.process_id, spawn.process_id);
    assert.equal(bottom.cols, 40);
    assert.equal(bottom.rows, 4);
    assert.ok(bottom.screen.includes('line08'), 'output exposes the rendered viewport text');
    const limited = await terminal.request('terminal.process.output', { process_id: spawn.process_id, max_lines: 2 }) as OutputResult;
    assert.deepEqual(limited.lines, bottom.lines.slice(-2));
    assert.equal(limited.screen, limited.lines.join('\n'));
    assert.equal(limited.rows, bottom.rows, 'limiting output does not resize the terminal');

    const visibleSearch = await terminal.request('terminal.process.search', {
      process_id: spawn.process_id,
      query: 'line08'
    }) as SearchResult;
    assert.ok(visibleSearch.matches.length >= 1, 'search finds text in the rendered viewport');

    await terminal.request('terminal.process.scroll', { process_id: spawn.process_id, lines: -5 });
    const scrolled = await terminal.request('terminal.process.output', { process_id: spawn.process_id }) as OutputResult;
    assert.ok(scrolled.display_offset > 0, 'scrollback updates the display offset');
    assert.ok(scrolled.screen.includes('line01'), 'output follows the scrolled viewport');

    await terminal.request('terminal.process.scroll', { process_id: spawn.process_id, lines: 5 });
    await terminal.request('terminal.process.wheel', { process_id: spawn.process_id, lines: -5, col: 0, row: 0 });
    const wheelScrolled = await terminal.request('terminal.process.output', { process_id: spawn.process_id }) as OutputResult;
    assert.ok(wheelScrolled.display_offset > 0, 'wheel updates scrollback when no terminal mouse mode is active');

    const hiddenSearch = await terminal.request('terminal.process.search', {
      process_id: spawn.process_id,
      query: 'line01'
    }) as SearchResult;
    assert.ok(hiddenSearch.matches.length >= 1, 'search follows the scrolled viewport');

    await terminal.request('terminal.process.select', {
      process_id: spawn.process_id,
      start_col: 0,
      start_row: 0,
      end_col: 5,
      end_row: 0
    });
    const selection = await terminal.request('terminal.process.selection_text', {
      process_id: spawn.process_id
    }) as SelectionResult;
    assert.equal(selection.text, 'line01');

    await terminal.request('terminal.process.select', {
      process_id: spawn.process_id,
      clear: true
    });
    const clearedSelection = await terminal.request('terminal.process.selection_text', {
      process_id: spawn.process_id
    }) as SelectionResult;
    assert.equal(clearedSelection.text, '', 'clearing selection removes copied text');

    await terminal.request('terminal.process.select', {
      process_id: spawn.process_id,
      start_col: 0,
      start_row: 0,
      end_col: 5,
      end_row: 1
    });
    const multilineSelection = await terminal.request('terminal.process.selection_text', {
      process_id: spawn.process_id
    }) as SelectionResult;
    assert.equal(multilineSelection.text, 'line01\nline02', 'hard-newline multiline selection preserves line breaks');

    const wrappedSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-wrap-smoke',
      ...script("printf 'abcdefghij'; sleep 1", [{ out: 'abcdefghij' }, { sleep: 1000 }]),
      cols: 5,
      rows: 2,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;

    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: wrappedSpawn.process_id }) as OutputResult;
      return output.screen.includes('fghij');
    }, 'wrapped terminal output should include the wrapped second row');

    await terminal.request('terminal.process.select', {
      process_id: wrappedSpawn.process_id,
      start_col: 0,
      start_row: 0,
      end_col: 4,
      end_row: 1
    });
    const wrappedSelection = await terminal.request('terminal.process.selection_text', {
      process_id: wrappedSpawn.process_id
    }) as SelectionResult;
    assert.equal(wrappedSelection.text, 'abcdefghij', 'soft-wrapped multiline selection does not insert a newline');

    const agentSubmitSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-agent-submit-smoke',
      kind: 'agent',
      ...script('IFS= read -r line; printf "submitted:%s\n" "$line"; sleep 1', [{ line: true }, { sleep: 1000 }]),
      cols: 40,
      rows: 3,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    const submitRequest = terminal.request('terminal.process.input', {
      process_id: agentSubmitSpawn.process_id,
      kind: 'text',
      text: 'pizza joke',
      submit: true
    });
    const statusStarted = performance.now();
    await terminal.request('terminal.process.status', { process_id: wrappedSpawn.process_id });
    assert.ok(performance.now() - statusStarted < 75, 'raw-agent settling does not block another terminal');
    await submitRequest;
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: agentSubmitSpawn.process_id }) as OutputResult;
      return output.screen.includes('submitted:pizza joke');
    }, 'agent submit writes a separate carriage return that submits the line');

    // ConPTY consumes OSC colour queries itself, so they never reach the sidecar.
    if (process.platform !== 'win32') {
      const colorQuerySpawn = await terminal.request('terminal.process.spawn', {
        name: 'sidecar-color-query-smoke',
        command: '/bin/sh',
        args: ['-lc', "stty raw -echo; printf '\\033]10;?\\033\\\\'; dd bs=1 count=25 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'; printf '\\r\\n'; printf '\\033]11;?\\033\\\\'; dd bs=1 count=25 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'; printf '\\r\\n'; printf '\\033]4;0;?\\033\\\\'; dd bs=1 count=26 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'; sleep 1"],
        cols: 80,
        rows: 6,
        cell_width: 8,
        cell_height: 16
      }) as SpawnResult;
      await waitFor(async () => {
        const output = await terminal.request('terminal.process.output', { process_id: colorQuerySpawn.process_id }) as OutputResult;
        return output.screen.includes('1b5d31303b7267623a666166612f666166612f666166611b5c')
          && output.screen.includes('1b5d31313b7267623a313531352f313531352f313531351b5c')
          && output.screen.includes('1b5d343b303b7267623a313831382f313831382f316231621b5c');
      }, 'terminal answers OSC foreground and background color queries');
    }

    const plainPasteSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-plain-paste-smoke',
      ...script("stty raw -echo; printf 'ready\\r\\n'; dd bs=1 count=3 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: 'ready\r\n' }, { hex: 3 }, { sleep: 1000 }]),
      cols: 40,
      rows: 3,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, plainPasteSpawn.process_id, 'ready');
    await terminal.request('terminal.process.input', {
      process_id: plainPasteSpawn.process_id,
      kind: 'paste',
      text: 'abc'
    });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: plainPasteSpawn.process_id }) as OutputResult;
      return output.screen.includes('61 62 63');
    }, 'paste writes raw text when bracketed paste mode is disabled');

    const bracketedPasteSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-bracketed-paste-smoke',
      ...script("stty raw -echo; printf '\\033[?2004h'; printf 'ready\\r\\n'; dd bs=1 count=15 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: '\x1b[?2004hready\r\n' }, { hex: 15 }, { sleep: 1000 }]),
      cols: 80,
      rows: 3,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, bracketedPasteSpawn.process_id, 'ready');
    await terminal.request('terminal.process.input', {
      process_id: bracketedPasteSpawn.process_id,
      kind: 'paste',
      text: 'abc'
    });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: bracketedPasteSpawn.process_id }) as OutputResult;
      return output.screen.includes('1b 5b 32 30 30 7e 61 62 63 1b 5b 32 30 31 7e');
    }, 'paste uses bracketed paste markers when bracketed paste mode is enabled');

    const altWheelSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-alt-wheel-smoke',
      ...script("stty raw -echo; printf '\\033[?1049h'; printf 'ready\\r\\n'; dd bs=1 count=3 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: '\x1b[?1049hready\r\n' }, { hex: 3 }, { sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, altWheelSpawn.process_id, 'ready');
    await terminal.request('terminal.process.wheel', { process_id: altWheelSpawn.process_id, lines: -1, col: 0, row: 0 });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: altWheelSpawn.process_id }) as OutputResult;
      return output.screen.includes('1b 5b 41');
    }, 'alternate-screen wheel sends cursor-up input');

    const mouseWheelSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-mouse-wheel-smoke',
      ...script("stty raw -echo; printf '\\033[?1000h\\033[?1006h'; printf 'ready\\r\\n'; dd bs=1 count=10 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: '\x1b[?1000h\x1b[?1006hready\r\n' }, { hex: 10 }, { sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, mouseWheelSpawn.process_id, 'ready');
    await terminal.request('terminal.process.wheel', { process_id: mouseWheelSpawn.process_id, lines: 1, col: 0, row: 0 });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: mouseWheelSpawn.process_id }) as OutputResult;
      return output.screen.includes('1b 5b 3c 36 35 3b 31 3b 31 4d');
    }, 'mouse-reporting wheel sends SGR mouse input');

    const noMouseSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-no-mouse-smoke',
      ...script('sleep 1', [{ sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    const noMouseResult = await terminal.request('terminal.process.mouse', {
      process_id: noMouseSpawn.process_id,
      event: 'down',
      button: 0,
      buttons: 1,
      col: 0,
      row: 0
    }) as MouseResult;
    assert.equal(noMouseResult.reported, false, 'plain mouse events are ignored when terminal mouse mode is disabled');

    const mouseClickSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-mouse-click-smoke',
      ...script("stty raw -echo; printf '\\033[?1000h\\033[?1006h'; printf 'ready\\r\\n'; dd bs=1 count=18 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: '\x1b[?1000h\x1b[?1006hready\r\n' }, { hex: 18 }, { sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, mouseClickSpawn.process_id, 'ready');
    await terminal.request('terminal.process.mouse', { process_id: mouseClickSpawn.process_id, event: 'down', button: 0, buttons: 1, col: 0, row: 0 });
    await terminal.request('terminal.process.mouse', { process_id: mouseClickSpawn.process_id, event: 'up', button: 0, buttons: 0, col: 0, row: 0 });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: mouseClickSpawn.process_id }) as OutputResult;
      const hex = normalizedHexDump(output.screen);
      return hex.includes('1b 5b 3c 30 3b 31 3b 31 4d')
        && hex.includes('1b 5b 3c 30 3b 31 3b 31 6d');
    }, 'mouse-reporting click sends SGR down and release input');

    const mouseDragSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-mouse-drag-smoke',
      ...script("stty raw -echo; printf '\\033[?1002h\\033[?1006h'; printf 'ready\\r\\n'; dd bs=1 count=19 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: '\x1b[?1002h\x1b[?1006hready\r\n' }, { hex: 19 }, { sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, mouseDragSpawn.process_id, 'ready');
    await terminal.request('terminal.process.mouse', { process_id: mouseDragSpawn.process_id, event: 'down', button: 0, buttons: 1, col: 0, row: 0 });
    await terminal.request('terminal.process.mouse', { process_id: mouseDragSpawn.process_id, event: 'move', button: 0, buttons: 1, col: 1, row: 0 });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: mouseDragSpawn.process_id }) as OutputResult;
      return normalizedHexDump(output.screen).includes('1b 5b 3c 33 32 3b 32 3b 31 4d');
    }, 'mouse-reporting drag sends SGR motion input');

    const mouseHoverSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-mouse-hover-smoke',
      ...script("stty raw -echo; printf '\\033[?1003h\\033[?1006h'; printf 'ready\\r\\n'; dd bs=1 count=10 2>/dev/null | od -An -tx1; sleep 1", [{ raw: true }, { out: '\x1b[?1003h\x1b[?1006hready\r\n' }, { hex: 10 }, { sleep: 1000 }]),
      cols: 40,
      rows: 4,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;
    await waitForScreen(terminal, mouseHoverSpawn.process_id, 'ready');
    await terminal.request('terminal.process.mouse', { process_id: mouseHoverSpawn.process_id, event: 'move', button: 0, buttons: 0, col: 2, row: 1 });
    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: mouseHoverSpawn.process_id }) as OutputResult;
      return normalizedHexDump(output.screen).includes('1b 5b 3c 33 35 3b 33 3b 32 4d');
    }, 'all-motion mouse mode sends SGR hover input');

    const shortLivedSpawn = await terminal.request('terminal.process.spawn', {
      name: 'sidecar-stop-exited-smoke',
      ...script('exit 0', [{ exit: 0 }]),
      cols: 10,
      rows: 2,
      cell_width: 8,
      cell_height: 16
    }) as SpawnResult;

    await waitFor(async () => {
      const output = await terminal.request('terminal.process.output', { process_id: shortLivedSpawn.process_id }) as OutputResult;
      return output.status === 'exited';
    }, 'short-lived terminal should exit before stop is requested');

    const stoppedAfterExit = await terminal.request('terminal.process.stop', {
      process_id: shortLivedSpawn.process_id
    }) as StopResult;
    assert.equal(stoppedAfterExit.ok, true, 'stopping an exited terminal is a successful no-op');
    assert.equal(stoppedAfterExit.status, 'exited');
    await terminal.request('terminal.process.subscribe', { process_id: shortLivedSpawn.process_id, subscribed: true });
    await terminal.request('terminal.process.close', { process_id: shortLivedSpawn.process_id });
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.deepEqual(
        await terminal.request('terminal.process.subscribe', { process_id: shortLivedSpawn.process_id, subscribed: false }),
        { ok: true, subscribed: false },
        'delayed or repeated unsubscribe after close is a successful no-op'
      );
    }
    await assert.rejects(
      terminal.request('terminal.process.subscribe', { process_id: shortLivedSpawn.process_id, subscribed: true }),
      /process not found/,
      'subscribing to a missing terminal still reports an error'
    );
  } finally {
    await terminal.dispose();
    debugLog.dispose();
  }
}

type ProbeStep =
  | { out: string }
  | { sleep: number }
  | { raw: boolean }
  | { hex: number; compact?: boolean }
  | { line: true }
  | { ticks: number; every: number }
  | { exit: number };

// What a terminal runs: the /bin/sh one-liner on POSIX. Windows has no /bin/sh,
// stty, dd, or od, so the same steps run in a Node probe there.
function script(posix: string, steps: ProbeStep[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: '/bin/sh', args: ['-lc', posix] };
  return { command: process.execPath, args: [path.resolve('tests/fixtures/terminalProbe.cjs'), JSON.stringify(steps)] };
}

async function waitForScreen(terminal: TerminalService, processId: string, text: string): Promise<void> {
  await waitFor(async () => {
    const output = await terminal.request('terminal.process.output', { process_id: processId }) as OutputResult;
    return output.screen.includes(text);
  }, `${processId} shows ${JSON.stringify(text)}`);
}

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function hasActivity(frames: LifecycleFrame[], processId: string, activity: string): boolean {
  return frames.some((frame) => frame.processId === processId && frame.event === 'activity' && frame.activity === activity);
}

function firstActivityAt(frames: LifecycleFrame[], processId: string, activity: string): number | null {
  return frames.find((frame) => frame.processId === processId && frame.event === 'activity' && frame.activity === activity)?.at ?? null;
}

function normalizedHexDump(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
