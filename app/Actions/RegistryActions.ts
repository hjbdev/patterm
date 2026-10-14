import { AbandonWorktreeAction } from './AbandonWorktreeAction';
import { CloseProcessAction } from './CloseProcessAction';
import { CreateProjectAction } from './CreateProjectAction';
import { CreateWorktreeAction } from './CreateWorktreeAction';
import { DiscoverHarnessesAction } from './DiscoverHarnessesAction';
import { GetCurrentDiffAction } from './GetCurrentDiffAction';
import { GetDiffFileAction } from './GetDiffFileAction';
import { LinkWorktreeAction } from './LinkWorktreeAction';
import { ListDirectoriesAction } from './ListDirectoriesAction';
import { ListWorktreesAction } from './ListWorktreesAction';
import { ProjectLogoAction } from './ProjectLogoAction';
import { RestartOpenCodeServiceAction } from './RestartOpenCodeServiceAction';
import { SearchArtifactsAction } from './SearchArtifactsAction';
import { StopProcessAction } from './StopProcessAction';
import { ProjectContextAction } from './ProjectContextAction';
import { ProjectContextService } from '../Services/ProjectContextService';
import type { DatabaseService } from '../Services/DatabaseService';
import type { DiffService } from '../Services/DiffService';
import type { HarnessDiscoveryService } from '../Services/HarnessDiscoveryService';
import type { SearchService } from '../Services/SearchService';
import type { TerminalService } from '../Services/TerminalService';
import type { TimelineService } from '../Services/TimelineService';
import type { WorktreeService } from '../Services/WorktreeService';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import type { OpenCodeServerService } from '../Services/OpenCodeServerService';
import type { NotificationService } from '../Services/NotificationService';

export interface RegistryActions {
  projectContext: ProjectContextAction;
  abandonWorktree: AbandonWorktreeAction;
  closeProcess: CloseProcessAction;
  createProject: CreateProjectAction;
  createWorktree: CreateWorktreeAction;
  discoverHarnesses: DiscoverHarnessesAction;
  getCurrentDiff: GetCurrentDiffAction;
  getDiffFile: GetDiffFileAction;
  linkWorktree: LinkWorktreeAction;
  listDirectories: ListDirectoriesAction;
  listWorktrees: ListWorktreesAction;
  projectLogo: ProjectLogoAction;
  restartOpenCodeService: RestartOpenCodeServiceAction;
  searchArtifacts: SearchArtifactsAction;
  stopProcess: StopProcessAction;
}

export interface RegistryActionDeps {
  database: DatabaseService;
  timeline: TimelineService;
  terminal: TerminalService;
  harnessDiscovery: HarnessDiscoveryService;
  worktreeService: WorktreeService;
  diffService: DiffService;
  searchService: SearchService;
  integrated?: Pick<IntegratedAgentService, 'stop' | 'stopIfLive'>;
  openCodeServer?: Pick<OpenCodeServerService, 'interrupt' | 'restartService'>;
  notifications?: Pick<NotificationService, 'resolve'>;
  onProcessesChanged?: () => void;
}

export function createRegistryActions(deps: RegistryActionDeps): RegistryActions {
  const contextService = new ProjectContextService(deps.database, deps.timeline);
  const projectContext = new ProjectContextAction(deps.database, contextService);
  return {
    projectContext,
    abandonWorktree: new AbandonWorktreeAction(deps.worktreeService),
    closeProcess: new CloseProcessAction(deps.database, deps.terminal, deps.openCodeServer, deps.integrated, deps.notifications, deps.onProcessesChanged),
    createProject: new CreateProjectAction(deps.database, deps.timeline),
    projectLogo: new ProjectLogoAction(deps.database, deps.timeline),
    createWorktree: new CreateWorktreeAction(deps.worktreeService, projectContext),
    discoverHarnesses: new DiscoverHarnessesAction(deps.database, deps.timeline, deps.harnessDiscovery),
    getCurrentDiff: new GetCurrentDiffAction(deps.diffService, contextService),
    getDiffFile: new GetDiffFileAction(deps.diffService, contextService),
    linkWorktree: new LinkWorktreeAction(deps.worktreeService, projectContext),
    listDirectories: new ListDirectoriesAction(),
    listWorktrees: new ListWorktreesAction(deps.worktreeService),
    restartOpenCodeService: new RestartOpenCodeServiceAction(deps.database, deps.timeline, deps.openCodeServer),
    searchArtifacts: new SearchArtifactsAction(deps.searchService),
    stopProcess: new StopProcessAction(deps.database, deps.terminal, deps.openCodeServer, deps.integrated, deps.onProcessesChanged),
  };
}
