// Delivery outcomes for Integrated prompts. Native providers do not all
// deduplicate, so an ambiguous submission is never retried automatically:
// callers either reconcile against native evidence or surface an uncertain,
// recoverable state to the user.

export type IntegratedDeliveryState = 'accepted' | 'unknown';

export class UncertainDeliveryError extends Error {
  constructor(message: string, readonly messageId?: string) {
    super(message);
    this.name = 'UncertainDeliveryError';
  }
}

// Correlation ids are correlation only unless a provider's own evidence proves
// acceptance. Codex `clientUserMessageId` and Claude user `uuid` are used to
// find the authoritative native record; OpenCode `msg_` ids are additionally
// idempotent, but the first payload wins, so callers must still change the id
// whenever the payload changes.

// The native agent is running a turn that cannot take input, such as Codex
// compaction or review, and definitively did not admit the prompt. Patterm
// holds the prompt and sends it once that turn ends.
export class TurnBusyError extends Error {
  constructor(message: string, readonly turnKind: string) {
    super(message);
    this.name = 'TurnBusyError';
  }
}
