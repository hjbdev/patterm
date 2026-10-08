import { shallowReactive } from 'vue';
import type { IntegratedControls } from './integratedConversation';

// Controls of the open Integrated conversations, so the command palette can
// offer their selectors without another request.
const published = shallowReactive(new Map<string, IntegratedControls>());

export function publishIntegratedControls(processId: string, controls: IntegratedControls | null): void {
  if (controls) published.set(processId, controls);
  else published.delete(processId);
}

export function publishedIntegratedControls(processId: string | null | undefined): IntegratedControls | null {
  return processId ? published.get(processId) ?? null : null;
}
