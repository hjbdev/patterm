import { z } from 'zod';

// Off, in the app only, or in the app plus desktop and push.
export const deliveryLevel = z.enum(['off', 'in_app', 'all']);
export type DeliveryLevel = z.infer<typeof deliveryLevel>;

export const notificationUrgency = z.enum(['low', 'normal', 'high']);
export type NotificationUrgency = z.infer<typeof notificationUrgency>;

export const NOTIFICATION_SOURCE_DEFAULTS = {
  agent_requests: 'all',
  agent_terminal: 'all',
  process_terminal: 'all',
  integrated_permission: 'all',
  integrated_turn_finished: 'all',
  agent_failures: 'all',
  process_failures: 'in_app',
  agent_bells: 'in_app',
  process_bells: 'off'
} as const satisfies Record<string, DeliveryLevel>;

export type NotificationCategory = keyof typeof NOTIFICATION_SOURCE_DEFAULTS;

export const notificationSettingsInput = z.object({
  sources: z.object({
    agent_requests: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.agent_requests),
    agent_terminal: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.agent_terminal),
    process_terminal: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.process_terminal),
    integrated_permission: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.integrated_permission),
    integrated_turn_finished: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.integrated_turn_finished),
    agent_failures: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.agent_failures),
    process_failures: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.process_failures),
    agent_bells: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.agent_bells),
    process_bells: deliveryLevel.default(NOTIFICATION_SOURCE_DEFAULTS.process_bells)
  }).default(NOTIFICATION_SOURCE_DEFAULTS),
  minimumUrgency: notificationUrgency.default('normal'),
  toasts: z.boolean().default(true),
  // Integrated turns that only report progress or wait on other agents stay
  // in the app instead of toasting and pushing.
  quietRoutineTurns: z.boolean().default(false)
});

export type NotificationSettings = z.infer<typeof notificationSettingsInput>;
