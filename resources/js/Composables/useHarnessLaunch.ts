import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { harnessLaunches, type HarnessLaunchInput } from '../lib/harnessLaunches';
import { useWorkbench } from './useWorkbench';

export function useHarnessLaunch() {
  const router = useRouter();
  const { projects, refresh } = useWorkbench();
  function launchHarness(input: HarnessLaunchInput): void {
    const launch = harnessLaunches.start(input, (args) => window.patterm.call('harness_launch', args));
    const opened = router.push({ name: 'launch', params: { projectId: input.projectId, launchId: launch.id } }).catch(() => {});
    void launch.finished.then(async (sessionId) => {
      if (!sessionId) return;
      // A refresh failure does not turn a successful native launch into a
      // failed one. The live workbench will catch up after reconnection.
      await refresh().catch(() => {});
      await opened;
      const route = router.currentRoute.value;
      if (route.name === 'launch' && route.params.projectId === input.projectId && route.params.launchId === launch.id) {
        await router.replace({ name: 'agent', params: { projectId: input.projectId, sessionId } });
      }
      if (projects.value.some((project) => project.project.id === input.projectId && project.projectSessions.some((session) => session.id === sessionId))) {
        harnessLaunches.dismiss(launch.id);
      }
    }).catch(() => { /* Navigation failures never retry native launches. */ });
  }
  return { launchHarness };
}

export function useSelectedHarnessLaunch() {
  const route = useRoute();
  return computed(() => route.name === 'launch' ? harnessLaunches.launches.find((launch) =>
    launch.id === route.params.launchId && launch.input.projectId === route.params.projectId
  ) ?? null : null);
}

export function useProjectHarnessLaunches(projectId: () => string | null) {
  const { projects } = useWorkbench();
  return computed(() => {
    const id = projectId();
    const sessions = projects.value.find((project) => project.project.id === id)?.projectSessions ?? [];
    return harnessLaunches.launches.filter((launch) => launch.input.projectId === id
      && !(launch.state === 'ready' && sessions.some((session) => session.id === launch.sessionId)));
  });
}
