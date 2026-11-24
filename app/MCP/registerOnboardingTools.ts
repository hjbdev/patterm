import type { GetOnboardingStatusAction, UpdateOnboardingAction } from '../Actions/OnboardingActions';
import type { McpToolRegistry } from './ToolRegistry';

// Owner-only: the Get started checklist in the sidebar.
export function registerOnboardingTools(
  registry: McpToolRegistry,
  actions: { status: GetOnboardingStatusAction; update: UpdateOnboardingAction }
) {
  registry.register(
    {
      name: 'onboarding_status',
      namespace: 'settings',
      hidden: true,
      changes: [],
      description: 'Read the Get started checklist. refresh re-scans for agent CLIs first.',
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } } }
    },
    (args) => actions.status.execute(args)
  );
  registry.register(
    {
      name: 'onboarding_update',
      namespace: 'settings',
      hidden: true,
      changes: ['settings'],
      description: 'Hide or restore the Get started checklist.',
      inputSchema: { type: 'object', required: ['dismissed'], properties: { dismissed: { type: 'boolean' } } }
    },
    (args) => actions.update.execute(args)
  );
}
