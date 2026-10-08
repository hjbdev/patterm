import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { routineRun, type RoutineRunRecord } from '../lib/routines';

// Opens a routine run from the Routines pages: a running run shows its
// conversation, any other its report.
export function useRoutineRunViewer(routineName: (routineId: string) => string) {
  const router = useRouter();
  const reportRun = ref<RoutineRunRecord | null>(null);
  const runProcessId = ref<string | null>(null);
  const runTitle = ref('');

  function openRun(run: RoutineRunRecord): void {
    if (run.status === 'running') openConversation(run);
    else reportRun.value = run;
  }

  // Project runs open as that project's agent tab; workspace runs open in a dialog.
  function openConversation(run: RoutineRunRecord): void {
    reportRun.value = null;
    if (run.project_id && run.session_id) {
      void router.push({ name: 'agent', params: { projectId: run.project_id, sessionId: run.session_id } });
      return;
    }
    if (!run.process_id) return;
    runTitle.value = routineName(run.routine_id);
    runProcessId.value = run.process_id;
  }

  // Pages call this when they refresh, so an open report shows a new report
  // and drops Open conversation once its agent stops. Refreshes can overlap,
  // so only the newest request's reply is used.
  let reportRequest = 0;
  async function refreshReport(): Promise<void> {
    const runId = reportRun.value?.run_id;
    if (!runId) return;
    const request = ++reportRequest;
    try {
      const fresh = await routineRun(runId);
      if (request === reportRequest && reportRun.value?.run_id === runId) reportRun.value = fresh;
    } catch {
      // A deleted routine takes its runs with it; the open copy stays until closed.
    }
  }

  return { reportRun, runProcessId, runTitle, openRun, openConversation, refreshReport };
}
