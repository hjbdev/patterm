import { createRouter, type Router, type RouterHistory } from 'vue-router';
// Each page loads with its first visit, so the app starts without every
// page's code. `prefetchPages` loads the rest once the first page is up.
const ProjectsPage = () => import('./Pages/ProjectsPage.vue');
const ProjectPage = () => import('./Pages/ProjectPage.vue');
const TerminalPage = () => import('./Pages/TerminalPage.vue');
const HarnessLaunchPage = () => import('./Pages/HarnessLaunchPage.vue');
const ResourcesPage = () => import('./Pages/ResourcesPage.vue');
const HistoryPage = () => import('./Pages/HistoryPage.vue');
const TodosPage = () => import('./Pages/TodosPage.vue');
const ScratchpadsPage = () => import('./Pages/ScratchpadsPage.vue');
const MediaPage = () => import('./Pages/MediaPage.vue');
const SettingsPage = () => import('./Pages/SettingsPage.vue');
const UsagePage = () => import('./Pages/UsagePage.vue');
const RoutinesPage = () => import('./Pages/RoutinesPage.vue');
const RoutineLogPage = () => import('./Pages/RoutineLogPage.vue');
import { rememberProjectLocation } from './lib/projectLocations';

export function createWorkbenchRouter(history: RouterHistory) {
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: '/projects' },
      { path: '/index.html', redirect: '/projects' },
      { path: '/settings', name: 'settings', component: SettingsPage },
      { path: '/usage', name: 'usage', component: UsagePage },
      { path: '/routines', name: 'routines', component: RoutinesPage },
      { path: '/routines/log', name: 'routineLog', component: RoutineLogPage },
      { path: '/projects', name: 'projects', component: ProjectsPage },
      { path: '/projects/:projectId', name: 'project', component: ProjectPage },
      { path: '/projects/:projectId/launches/:launchId', name: 'launch', component: HarnessLaunchPage },
      { path: '/projects/:projectId/agents/:sessionId', name: 'agent', component: TerminalPage },
      { path: '/projects/:projectId/processes/:processId', name: 'process', component: TerminalPage },
      { path: '/projects/:projectId/worktrees', name: 'worktrees', component: ResourcesPage },
      // The Diffs page is gone; its old links open the agent, whose sidebar lists its worktrees.
      { path: '/projects/:projectId/agents/:sessionId/diffs', redirect: to => ({ name: 'agent', params: to.params }) },
      { path: '/projects/:projectId/history', name: 'history', component: HistoryPage },
      { path: '/projects/:projectId/todos/:recordId?', name: 'todos', component: TodosPage },
      { path: '/projects/:projectId/scratchpads/:recordId?', name: 'scratchpads', component: ScratchpadsPage },
      { path: '/projects/:projectId/media', name: 'media', component: MediaPage },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: ProjectsPage }
    ]
  });
  router.afterEach((to, _from, failure) => { if (!failure) rememberProjectLocation(to); });
  return router;
}

export function prefetchPages(): void {
  for (const page of [TerminalPage, HarnessLaunchPage, ProjectPage, ProjectsPage, HistoryPage, TodosPage, ScratchpadsPage, MediaPage, ResourcesPage, SettingsPage, UsagePage, RoutinesPage, RoutineLogPage]) void page().catch(() => {
    // The page reports a failed load when it is opened.
  });
}

// What browsers and Vite report when a page's code can't be fetched.
const STALE_BUILD = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;
const STALE_RELOAD_KEY = 'patterm.staleReload';

function tabStorage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

// A tab keeps the build it loaded. After a server update, a page whose code it
// never loaded is gone and opening it fails; load the new build at that page
// instead. A page that still fails after one reload is broken, not stale, and
// stays put. The launch view is left alone: its launch is already running, and
// useHarnessLaunch opens the agent when it can't show.
export function reloadOnStaleBuild(router: Router, reload: (url: string) => void = (url) => window.location.assign(url), storage: () => Storage | null = tabStorage): void {
  router.onError((error, to) => {
    if (!STALE_BUILD.test(error instanceof Error ? error.message : String(error)) || to.name === 'launch') return;
    const url = router.resolve(to).href;
    // Without storage to remember the attempt, a broken page could reload forever.
    try {
      const store = storage();
      if (!store || store.getItem(STALE_RELOAD_KEY) === url) return;
      store.setItem(STALE_RELOAD_KEY, url);
    } catch { return; }
    reload(url);
  });
  router.afterEach((_to, _from, failure) => {
    if (failure) return;
    try { storage()?.removeItem(STALE_RELOAD_KEY); } catch { /* Nothing to clear. */ }
  });
}
