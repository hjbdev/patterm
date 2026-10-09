import path from 'node:path';
import { createRegistryActions } from '../../app/Actions/RegistryActions';
import { harnessProviders } from '../../app/Harness/providers';
import { createMcpRegistry } from '../../app/MCP/createMcpRegistry';
import type { McpToolRegistry } from '../../app/MCP/ToolRegistry';
import type { WorkbenchRepository } from '../../app/Repositories/WorkbenchRepository';
import { DiffService } from '../../app/Services/DiffService';
import { HarnessDiscoveryService } from '../../app/Services/HarnessDiscoveryService';
import { HarnessLauncher } from '../../app/Services/HarnessLauncher';
import { ProcessLauncher } from '../../app/Services/ProcessLauncher';
import { SearchService } from '../../app/Services/SearchService';
import type { DatabaseService } from '../../app/Services/DatabaseService';
import type { TerminalService } from '../../app/Services/TerminalService';
import type { TimelineService } from '../../app/Services/TimelineService';
import { WorktreeService } from '../../app/Services/WorktreeService';
import type { AgentHistoryImportQueueService } from '../../app/Services/AgentHistory/AgentHistoryImportQueueService';
import type { AgentHistoryReadService } from '../../app/Services/AgentHistory/AgentHistoryReadService';
import type { HarnessModelCatalogService } from '../../app/Services/HarnessModelCatalogService';
import type { HarnessPresetService } from '../../app/Services/HarnessPresetService';
import type { NotificationActions } from '../../app/Actions/NotificationActions';

export function createTestMcpRegistry(input: {
  tempDir: string;
  database: DatabaseService;
  timeline: TimelineService;
  terminal: TerminalService;
  workbench: WorkbenchRepository;
  harnessDiscovery?: HarnessDiscoveryService;
  harnessLauncher?: HarnessLauncher;
  processLauncher?: ProcessLauncher;
  worktreeService?: WorktreeService;
  diffService?: DiffService;
  searchService?: SearchService;
  harnessPresets?: HarnessPresetService;
  modelCatalog?: HarnessModelCatalogService;
  historyImportQueue?: AgentHistoryImportQueueService;
  historyReadService?: AgentHistoryReadService;
  notifications?: NotificationActions;
  integrated?: Parameters<typeof createMcpRegistry>[0]['integrated'];
  assistant?: Parameters<typeof createMcpRegistry>[0]['assistant'];
  assistantInbox?: Parameters<typeof createMcpRegistry>[0]['assistantInbox'];
  assistantMemory?: Parameters<typeof createMcpRegistry>[0]['assistantMemory'];
  timers?: Parameters<typeof createMcpRegistry>[0]['timers'];
  closeRequests?: Parameters<typeof createMcpRegistry>[0]['closeRequests'];
}): McpToolRegistry {
  const harnessDiscovery = input.harnessDiscovery ?? new HarnessDiscoveryService(harnessProviders);
  const harnessLauncher =
    input.harnessLauncher ??
    new HarnessLauncher({
      database: input.database,
      timeline: input.timeline,
      terminal: input.terminal,
      workbench: input.workbench,
      providers: harnessProviders,
      nodePath: process.execPath,
      shimPath: '/tmp/patterm-mcp.js',
      socketPath: '/tmp/mcp.sock',
      runtimeDir: path.join(input.tempDir, 'harness')
    });
  const processLauncher = input.processLauncher ?? new ProcessLauncher({ database: input.database, timeline: input.timeline, terminal: input.terminal, workbench: input.workbench });
  const worktreeService = input.worktreeService ?? new WorktreeService({ database: input.database, timeline: input.timeline, workbench: input.workbench });
  const diffService = input.diffService ?? new DiffService({ worktrees: worktreeService });
  const searchService = input.searchService ?? new SearchService(input.database);
  const actions = createRegistryActions({
    database: input.database,
    timeline: input.timeline,
    terminal: input.terminal,
    harnessDiscovery,
    worktreeService,
    diffService,
    searchService,
  });

  return createMcpRegistry({
    actions,
    database: input.database,
    terminal: input.terminal,
    timeline: input.timeline,
    workbench: input.workbench,
    harnessDiscovery,
    harnessLauncher,
    ...(input.harnessPresets ? { harnessPresets: input.harnessPresets } : {}),
    ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {}),
    processLauncher,
    searchService,
    ...(input.historyImportQueue ? { historyImportQueue: input.historyImportQueue } : {}),
    ...(input.historyReadService ? { historyReadService: input.historyReadService } : {}),
    ...(input.notifications ? { notifications: input.notifications } : {}),
    ...(input.integrated ? { integrated: input.integrated } : {}),
    ...(input.assistant ? { assistant: input.assistant } : {}),
    ...(input.assistantInbox ? { assistantInbox: input.assistantInbox } : {}),
    ...(input.assistantMemory ? { assistantMemory: input.assistantMemory } : {}),
    ...(input.timers ? { timers: input.timers } : {}),
    ...(input.closeRequests ? { closeRequests: input.closeRequests } : {})
  });
}
