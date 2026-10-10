import { createRouter, type RouterHistory } from 'vue-router';
// Each page loads with its first visit, so the app starts without every
// page's code. `prefetchPages` loads the rest once the first page is up.
const ProjectsPage = () => import('./Pages/ProjectsPage.vue');
const TerminalPage = () => import('./Pages/TerminalPage.vue');
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
      { path: '/projects/:projectId', name: 'project', component: TerminalPage },
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
  for (const page of [TerminalPage, ProjectsPage, HistoryPage, TodosPage, ScratchpadsPage, MediaPage, ResourcesPage, SettingsPage, UsagePage, RoutinesPage, RoutineLogPage]) void page().catch(() => {
    // The page reports a failed load when it is opened.
  });
}
