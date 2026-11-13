import { isOpenCodeVersionMismatch } from '../../../app/Services/OpenCodeServiceErrors';

// Keep provider diagnostics available without making them the recovery UI.
export function conversationFailure(message: string): { title: string; detail: string } {
  if (isOpenCodeVersionMismatch(message)) return {
    title: 'OpenCode needs a server update',
    detail: 'The installed CLI and shared server versions differ. Your conversation is saved. Wait for other OpenCode turns to finish and try again, or explicitly restart the shared server below.'
  };
  if (/cloudflare/i.test(message) && /403|attention required/i.test(message)) return {
    title: 'Cloudflare blocked the provider request',
    detail: 'The provider did not accept the request. This does not necessarily mean your login expired. You can try your message again, or restart the agent to reconnect. Restarting cannot bypass Cloudflare.'
  };
  return { title: 'The agent could not complete this action', detail: 'Your conversation is still here. Check the details below before trying again.' };
}
