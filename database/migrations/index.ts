import addAutoSummaryUsage from './2026_10_16_000050_add_auto_summary_usage';
import addSummaryMemory from './2026_10_12_000048_add_summary_memory';
import addContextRevisions from './2026_10_15_000049_add_context_revisions';
import addHarnessRateLimitReadings from './2026_10_16_000051_add_harness_rate_limit_readings';
import addProcessBackgroundTasks from './2026_10_16_000052_add_process_background_tasks';
import addProcessSnooze from './2026_10_19_000053_add_process_snooze';
import addProjectSnooze from './2026_10_19_000054_add_project_snooze';
import addProcessAsking from './2026_10_29_000055_add_process_asking';
import createInitialSchema from './2026_06_03_000001_create_initial_schema';
import addProcessRuntimeColumns from './2026_06_03_000002_add_process_runtime_columns';
import addProcessWorktreeId from './2026_06_03_000003_add_process_worktree_id';
import rebuildTaskArtifactsFtsScope from './2026_06_03_000004_rebuild_task_artifacts_fts_scope';
import addSessionMcpIdentity from './2026_06_03_000005_add_session_mcp_identity';
import addProcessActivity from './2026_06_04_000006_add_process_activity';
import addSessionDisplayName from './2026_06_04_000007_add_session_display_name';
import addPerformanceIndexes from './2026_06_04_000008_add_performance_indexes';
import addTaskDescription from './2026_06_04_000009_add_task_description';
import addProcessExitMetadata from './2026_06_08_000010_add_process_exit_metadata';
import addConversationHistory from './2026_07_01_000011_add_conversation_history';
import addHistoryImportLookupIndexes from './2026_07_03_000012_add_history_import_lookup_indexes';
import addHistoryImportWatermarks from './2026_07_03_000013_add_history_import_watermarks';
import createAppArtifactsSearchIndex from './2026_07_15_000014_create_app_artifacts_search_index';
import addTaskIdentifiers from './2026_07_17_000015_add_task_identifiers';
import addTaskPriority from './2026_07_21_000016_add_task_priority';
import type { Migration } from '../../app/Database/Migration';
import removeTasks from './2026_09_08_000017_remove_tasks';
import addAutoSummaries from './2026_09_08_000018_add_auto_summaries';
import addProjectContext from './2026_09_08_000018_add_project_context';
import addSessionTitleOverride from './2026_09_09_000019_add_session_title_override';
import addRuntimeTimers from './2026_09_10_000020_add_runtime_timers';
import addIntegratedSessions from './2026_09_11_000021_add_integrated_sessions';
import addIntegratedSubmissions from './2026_09_22_000022_add_integrated_submissions';
import addNotifications from './2026_09_30_000023_add_notifications';
import addFeed from './2026_09_30_000024_add_feed';
import addMcpServers from './2026_09_30_000025_add_mcp_servers';
import addSessionWorktrees from './2026_10_01_000026_add_session_worktrees';
import addSessionServiceTier from './2026_10_01_000027_add_session_service_tier';
import addProjectKind from './2026_10_02_000028_add_project_kind';
import addCacheCompaction from './2026_10_03_000029_add_cache_compaction';
import addProcessTurnStart from './2026_10_03_000030_add_process_turn_start';
import addAssistantInbox from './2026_10_05_000031_add_assistant_inbox';
import addIntegratedHeldPrompts from './2026_10_05_000032_add_integrated_held_prompts';
import addHarnessRateLimits from './2026_10_05_000033_add_harness_rate_limits';
import removeFeed from './2026_10_05_000034_remove_feed';
import addRoutines from './2026_10_05_000035_add_routines';
import addRoutineRunReport from './2026_10_06_000036_add_routine_run_report';
import backfillRoutineRunReports from './2026_10_06_000037_backfill_routine_run_reports';
import addRoutineRunAt from './2026_10_06_000038_add_routine_run_at';
import addProjectLogo from './2026_10_06_000039_add_project_logo';
import addProcessCloseRequest from './2026_10_06_000040_add_process_close_request';
import addHosts from './2026_10_06_000041_add_hosts';
import addProjectLinks from './2026_10_06_000042_add_project_links';
import addPeerMessages from './2026_10_06_000043_add_peer_messages';
import addRoutineRemoteCreator from './2026_10_06_000044_add_routine_remote_creator';
import recordMcpHelperCutover from './2026_10_07_000045_record_mcp_helper_cutover';
import addSessionModel from './2026_09_10_000021_add_session_model';
import addAssistantMemory from './2026_10_09_000046_add_assistant_memory';
import addAutoTitles from './2026_10_12_000047_add_auto_titles';

export const migrations: Migration[] = [
  createInitialSchema,
  addProcessRuntimeColumns,
  addProcessWorktreeId,
  rebuildTaskArtifactsFtsScope,
  addSessionMcpIdentity,
  addProcessActivity,
  addSessionDisplayName,
  addPerformanceIndexes,
  addTaskDescription,
  addProcessExitMetadata,
  addConversationHistory,
  addHistoryImportLookupIndexes,
  addHistoryImportWatermarks,
  createAppArtifactsSearchIndex,
  addTaskIdentifiers,
  addTaskPriority,
  removeTasks,
  addAutoSummaries,
  addProjectContext,
  addSessionTitleOverride,
  addRuntimeTimers,
  addSessionModel,
  addIntegratedSessions,
  addIntegratedSubmissions,
  addNotifications,
  addFeed,
  addMcpServers,
  addSessionWorktrees,
  addSessionServiceTier,
  addProjectKind,
  addCacheCompaction,
  addProcessTurnStart,
  addAssistantInbox,
  addIntegratedHeldPrompts,
  addHarnessRateLimits,
  removeFeed,
  addRoutines,
  addRoutineRunReport,
  backfillRoutineRunReports,
  addRoutineRunAt,
  addProjectLogo,
  addProcessCloseRequest,
  addHosts,
  addProjectLinks,
  addPeerMessages,
  addRoutineRemoteCreator,
  recordMcpHelperCutover,
  addAssistantMemory,
  addAutoTitles,
  addSummaryMemory,
  addContextRevisions,
  addAutoSummaryUsage,
  addHarnessRateLimitReadings,
  addProcessBackgroundTasks,
  addProcessSnooze,
  addProjectSnooze,
  addProcessAsking
];
