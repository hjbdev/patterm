import type { RedactedText } from './AgentHistoryTypes';

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
  // Match only at a key boundary. Check the secret name separately so failed
  // assignments cannot repeatedly rescan a long key containing many matches.
  /(?<![A-Za-z0-9_-])(?=["']?[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|auth))(["']?[A-Za-z0-9_-]+["']?\s*[:=]\s*["']?)[^'"\s,}]{8,}(["']?)/gi,
  /\b(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
];

// Values the user stored as agent secrets. They are masked exactly, before
// the patterns, wherever they turn up.
let knownValues: string[] = [];

export class SecretRedactor {
  static useKnownValues(values: readonly string[]): void {
    knownValues = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  }

  redact(input: string | null | undefined): RedactedText {
    let text = input ?? '';
    let redactionCount = 0;
    for (const value of knownValues) {
      if (!text.includes(value)) continue;
      const parts = text.split(value);
      redactionCount += parts.length - 1;
      text = parts.join('[REDACTED]');
    }
    for (const pattern of SECRET_PATTERNS) {
      text = text.replace(pattern, (...args: unknown[]) => {
        redactionCount += 1;
        const prefix = typeof args[1] === 'string' && pattern.source.includes('[:=]') ? args[1] : '';
        const suffix = typeof args[2] === 'string' && prefix ? args[2] : '';
        return `${prefix}[REDACTED]${suffix}`;
      });
    }
    return { text, redactionCount };
  }

  // Stored secret values anywhere in structured data, such as a tool's
  // metadata. Patterns are left to the text fields.
  maskKnown<T>(value: T): T {
    if (!knownValues.length) return value;
    if (typeof value === 'string') return knownValues.reduce((text, known) => text.split(known).join('[REDACTED]'), value as string) as T;
    if (Array.isArray(value)) return value.map((entry) => this.maskKnown(entry)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.maskKnown(entry)])) as T;
    }
    return value;
  }

  redactAndCap(input: string | null | undefined, cap: number): RedactedText {
    const redacted = this.redact(input);
    if (redacted.text.length <= cap) {
      return redacted;
    }
    return { text: `${redacted.text.slice(0, cap)}\n[truncated]`, redactionCount: redacted.redactionCount };
  }
}
