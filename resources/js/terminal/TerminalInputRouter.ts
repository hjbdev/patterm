export type TerminalInputKind = 'text' | 'paste';

export interface TerminalInputDispatch {
  kind: TerminalInputKind;
  text: string;
}

export interface TerminalClipboardPaste {
  text: string;
  hasImage: boolean;
  formats: string[];
}

export interface TerminalInputSender {
  sendInput(input: TerminalInputDispatch): void;
  sendControl(text: string): void;
  readClipboard(): Promise<TerminalClipboardPaste>;
}

export interface TerminalTextSink {
  value: string;
}

export interface TerminalKeyboardEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface TerminalBeforeInputEventLike {
  inputType: string;
  data: string | null;
  dataTransfer?: { getData(type: string): string } | null;
  preventDefault(): void;
}

export interface TerminalClipboardEventLike {
  clipboardData?: { getData(type: string): string; types?: readonly string[] } | null;
  preventDefault(): void;
}

export interface TerminalCompositionEventLike {
  data: string;
}

export class TerminalInputRouter {
  private composingText = false;
  private pendingTextInput = false;

  constructor(
    private readonly sink: TerminalTextSink,
    private readonly sender: TerminalInputSender
  ) {}

  handleKeydown(event: TerminalKeyboardEventLike): boolean {
    if (isPasteShortcut(event)) {
      event.preventDefault();
      void this.pasteFromClipboard();
      return true;
    }

    const text = keyToTerminalInput(event);
    if (!text) {
      return false;
    }

    event.preventDefault();
    this.sender.sendControl(text);
    return true;
  }

  handlePaste(event: TerminalClipboardEventLike): boolean {
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      event.preventDefault();
      this.sender.sendInput({ kind: 'paste', text });
      return true;
    }

    if (clipboardDataHasImage(event.clipboardData)) {
      event.preventDefault();
      this.sender.sendControl('\u0016');
      return true;
    }

    return false;
  }

  handleBeforeInput(event: TerminalBeforeInputEventLike): boolean {
    if (event.inputType === 'insertFromPaste') {
      const text = event.dataTransfer?.getData('text/plain') ?? event.data ?? '';
      if (text) {
        event.preventDefault();
        this.sender.sendInput({ kind: 'paste', text });
        this.clearSink();
        return true;
      }
      return false;
    }

    if (event.inputType.startsWith('insert') && !this.composingText) {
      this.pendingTextInput = true;
    }

    return false;
  }

  handleInput(): boolean {
    if (this.composingText) {
      return false;
    }

    const text = this.sink.value;
    this.clearSink();
    if (!text) {
      this.pendingTextInput = false;
      return false;
    }

    this.pendingTextInput = false;
    this.sender.sendInput({ kind: 'text', text });
    return true;
  }

  handleCompositionStart(): void {
    this.composingText = true;
  }

  handleCompositionEnd(event: TerminalCompositionEventLike): boolean {
    this.composingText = false;
    const text = event.data || this.sink.value;
    this.clearSink();
    this.pendingTextInput = false;
    if (!text) {
      return false;
    }

    this.sender.sendInput({ kind: 'text', text });
    return true;
  }

  clearSink(): void {
    this.sink.value = '';
  }

  hasPendingTextInput(): boolean {
    return this.pendingTextInput;
  }

  private async pasteFromClipboard(): Promise<void> {
    const paste = await this.sender.readClipboard();
    if (paste.text) {
      this.sender.sendInput({ kind: 'paste', text: paste.text });
      return;
    }

    if (paste.hasImage) {
      this.sender.sendControl('\u0016');
    }
  }
}

function clipboardDataHasImage(data: TerminalClipboardEventLike['clipboardData']): boolean {
  return data?.types?.some((type) => type.toLowerCase().startsWith('image/')) ?? false;
}

export function isPasteShortcut(event: Pick<TerminalKeyboardEventLike, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
    return true;
  }
  return event.shiftKey && event.key === 'Insert';
}

export function keyToTerminalInput(event: Pick<TerminalKeyboardEventLike, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  const ctrlInput = controlKeyInput(event);
  if (ctrlInput) {
    return withAltPrefix(event, ctrlInput);
  }

  const navigationInput = navigationKeyInput(event);
  if (navigationInput) {
    return withAltPrefix(event, navigationInput);
  }

  if (event.key.length === 1 && event.altKey && !event.metaKey && !event.ctrlKey) {
    return withAltPrefix(event, event.key);
  }

  return null;
}

function navigationKeyInput(event: Pick<TerminalKeyboardEventLike, 'key' | 'ctrlKey' | 'shiftKey'>): string | null {
  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Escape':
      return '\u001b';
    case 'Backspace':
      return '\u007f';
    case 'Tab':
      return event.shiftKey ? '\u001b[Z' : '\t';
    case 'ArrowUp':
      return event.ctrlKey ? '\u001b[1;5A' : '\u001b[A';
    case 'ArrowDown':
      return event.ctrlKey ? '\u001b[1;5B' : '\u001b[B';
    case 'ArrowRight':
      return event.ctrlKey ? '\u001b[1;5C' : '\u001b[C';
    case 'ArrowLeft':
      return event.ctrlKey ? '\u001b[1;5D' : '\u001b[D';
    case 'Home':
      return '\u001b[H';
    case 'End':
      return '\u001b[F';
    case 'PageUp':
      return '\u001b[5~';
    case 'PageDown':
      return '\u001b[6~';
    case 'Delete':
      return '\u001b[3~';
    case 'Insert':
      return '\u001b[2~';
    default:
      return null;
  }
}

function controlKeyInput(event: Pick<TerminalKeyboardEventLike, 'key' | 'ctrlKey' | 'metaKey'>): string | null {
  if (!event.ctrlKey || event.metaKey) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key.length === 1 && key >= 'a' && key <= 'z') {
    return String.fromCharCode(key.charCodeAt(0) - 96);
  }

  switch (event.key) {
    case '[':
      return '\u001b';
    case '\\':
      return '\u001c';
    case ']':
      return '\u001d';
    case '^':
      return '\u001e';
    case '_':
      return '\u001f';
    default:
      return null;
  }
}

function withAltPrefix(event: Pick<TerminalKeyboardEventLike, 'altKey'>, text: string): string {
  return event.altKey ? `\u001b${text}` : text;
}
