import { toast } from 'vue-sonner';
import { isOpenCodeVersionMismatch } from '../../../app/Services/OpenCodeServiceErrors';

// Shows a launch failure. When OpenCode's shared server is older than its CLI,
// offers to restart the server and retry; the restart interrupts running
// OpenCode turns, so it needs the click. Remote launches restart nothing here.
export function toastLaunchError(caught: unknown, fallback: string, retry?: () => Promise<void> | void): void {
  const message = caught instanceof Error ? caught.message : fallback;
  if (!retry || !isOpenCodeVersionMismatch(message)) {
    toast.error(message);
    return;
  }
  toast.error('OpenCode CLI and server versions differ', {
    description: 'Restart the shared OpenCode server to launch. This interrupts running OpenCode turns, including sessions outside Patterm.',
    duration: Infinity,
    action: { label: 'Restart server', onClick: () => void restartAndRetry(retry) }
  });
}

async function restartAndRetry(retry: () => Promise<void> | void): Promise<void> {
  const id = toast.loading('Restarting the OpenCode server…');
  try {
    await window.patterm.call('opencode_service_restart', {});
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Could not restart the OpenCode server', { id });
    return;
  }
  toast.dismiss(id);
  await retry();
}
