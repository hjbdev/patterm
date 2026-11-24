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
