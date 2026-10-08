export type ProjectViewMode = 'agents' | 'processes' | 'worktrees' | 'todos' | 'scratchpads';
export type WorkbenchScreen = 'project-selector' | 'worktrees' | 'todos' | 'scratchpads' | 'agent-project' | 'process-project';

export interface WorkbenchNavigationState {
  activeProjectId: string | null;
  projectViewMode: ProjectViewMode;
}

export interface TopBarProjectSelectionState {
  activeProjectId: string | null;
  activeTerminalId: string | null;
  pendingExplicitTerminalId: string | null;
}

export function resolveWorkbenchScreen(state: WorkbenchNavigationState): WorkbenchScreen {
  if (!state.activeProjectId) {
    return 'project-selector';
  }

  if (state.projectViewMode === 'agents') {
    return 'agent-project';
  }

  if (state.projectViewMode === 'processes') {
    return 'process-project';
  }

  return state.projectViewMode;
}

export function resolveTopBarProjectSelection(
  active: TopBarProjectSelectionState,
  selectedProjectId: string | null
): TopBarProjectSelectionState {
  if (selectedProjectId === null) {
    return {
      ...active,
      activeProjectId: null,
      activeTerminalId: null,
      pendingExplicitTerminalId: null
    };
  }

  if (selectedProjectId === active.activeProjectId) {
    return active;
  }

  return {
    ...active,
    activeProjectId: selectedProjectId,
    activeTerminalId: null,
    pendingExplicitTerminalId: null
  };
}
