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

export class SecretRedactor {
  redact(input: string | null | undefined): RedactedText {
    let text = input ?? '';
    let redactionCount = 0;
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

  redactAndCap(input: string | null | undefined, cap: number): RedactedText {
    const redacted = this.redact(input);
    if (redacted.text.length <= cap) {
      return redacted;
    }
    return { text: `${redacted.text.slice(0, cap)}\n[truncated]`, redactionCount: redacted.redactionCount };
  }
}
