// Holds a displayed value steady while its source flickers. A new value is
// shown once it has lasted `delayFor(next, shown)` milliseconds, and a shown
// value stays for at least `minimumMs` before it can be replaced. Changes that
// `immediate` accepts, such as the user muting, skip both.
export class SettledValue<T> {
  // The starting value counts as settled, so the first change needs no minimum.
  private shownAt = Number.NEGATIVE_INFINITY;
  private pending: { value: T; since: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private shown: T,
    private readonly apply: (value: T) => void,
    private readonly options: {
      delayFor?: (next: T, shown: T) => number;
      minimumMs?: number;
      immediate?: (next: T, shown: T) => boolean;
      now?: () => number;
    } = {}
  ) {}

  get value(): T {
    return this.shown;
  }

  set(value: T): void {
    if (Object.is(value, this.shown)) {
      this.cancel();
      return;
    }
    if (!this.pending || !Object.is(this.pending.value, value)) this.pending = { value, since: this.now() };
    this.schedule();
  }

  dispose(): void {
    this.cancel();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    if (!pending) return;
    if (this.options.immediate?.(pending.value, this.shown)) {
      this.show(pending.value);
      return;
    }
    const delay = this.options.delayFor?.(pending.value, this.shown) ?? 0;
    const due = Math.max(pending.since + delay, this.shownAt + (this.options.minimumMs ?? 0));
    const wait = due - this.now();
    if (wait <= 0) this.show(pending.value);
    else this.timer = setTimeout(() => this.schedule(), wait);
  }

  private show(value: T): void {
    this.cancel();
    this.shown = value;
    this.shownAt = this.now();
    this.apply(value);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
