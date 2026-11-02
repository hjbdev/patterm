import { z } from 'zod';

// Usage telemetry is opt-in. It stays off, and sends nothing, until the
// owner turns it on and gives a PostHog project key.
export const TELEMETRY_HOSTS = { us: 'https://us.i.posthog.com', eu: 'https://eu.i.posthog.com' } as const;

const projectKey = z.string().trim().max(200).regex(/^(phc_[A-Za-z0-9_-]+)?$/, 'Use a PostHog project API key, which starts with phc_');

export const telemetrySettingsInput = z.object({
  enabled: z.boolean().default(false),
  apiKey: projectKey.default(''),
  host: z.enum(['us', 'eu']).default('us'),
  // A random ID made when telemetry is turned on and forgotten when it is
  // turned off, so each opt-in starts a new, unlinked identity.
  installId: z.string().uuid().nullable().default(null)
}).strict();
export type TelemetrySettings = z.infer<typeof telemetrySettingsInput>;

export const telemetrySettingsUpdate = z.object({
  enabled: z.boolean(),
  apiKey: projectKey,
  host: z.enum(['us', 'eu'])
}).strict();

// Everything a client may report is an identifier from Patterm's own code:
// route names, component names, and data-feature attributes. Never text.
export const telemetryIdentifier = z.string().regex(/^[A-Za-z0-9_.:/+-]{1,120}$/);

export const telemetryRecordInput = z.object({
  app_version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/).optional(),
  // Counted interactions since the last report, keyed by identifier.
  clicks: z.record(telemetryIdentifier, z.number().int().positive().max(100_000)).default({}),
  views: z.record(telemetryIdentifier, z.number().int().positive().max(100_000)).default({}),
  // Seconds spent on each page since the last report.
  seconds: z.record(telemetryIdentifier, z.number().nonnegative().max(86_400)).default({}),
  // Every component the build ships, so unused ones can be listed.
  components: z.array(telemetryIdentifier).max(2000).optional()
}).strict().refine((input) => Object.keys(input.clicks).length + Object.keys(input.views).length + Object.keys(input.seconds).length <= 2000, 'Too many entries');

export const telemetryFeedbackInput = z.object({
  sentiment: z.enum(['like', 'dislike']),
  feature: telemetryIdentifier.optional(),
  note: z.string().trim().max(2000).default('')
}).strict();
