// Browser-safe capability types shared by backend adapters, workbench records,
// and renderer controls without pulling Node-only backend modules into Vue builds.

export type AgentHostKind = 'supervised-socket' | 'external-daemon';

export interface AgentCapabilitiesDto {
  hostKind: AgentHostKind;
  input: {
    steering: boolean;
    nativeQueue: boolean;
    configureWhileBusy: boolean;
  };
  interactions: {
    permissions: boolean;
    questions: boolean;
    forms: boolean;
  };
  features: {
    goals: boolean;
    compact: boolean;
    slashCommands: boolean;
    voice: boolean;
    statelessGenerate: boolean;
    serviceTier: boolean;
    olderMessages: boolean;
    taskOutput: boolean;
  };
  selectors: {
    reasoning?: string;
    speed?: string;
  };
  messageIdPrefix?: string;
}

// Static capability defaults for pure schema validation and custom-model
// fallbacks that run without a live AgentAdapterRegistry.
const SERVICE_TIER_HARNESSES = new Set<string>(['codex']);
const DEFAULT_REASONING_LEVELS: Readonly<Record<string, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max']
};

export function harnessSupportsServiceTier(harness: string): boolean {
  return SERVICE_TIER_HARNESSES.has(harness);
}

export function defaultReasoningLevelsFor(harness: string): string[] {
  return [...(DEFAULT_REASONING_LEVELS[harness] ?? [])];
}
