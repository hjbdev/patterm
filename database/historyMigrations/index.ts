import createConversationHistorySchema from './2026_07_04_000001_create_conversation_history_schema';
import createHistorySearchIndexState from './2026_07_15_000002_create_history_search_index_state';
import type { Migration } from '../../app/Database/Migration';
import removeTaskScope from './2026_09_08_000003_remove_task_scope';
import indexHistorySearchRows from './2026_09_09_000004_index_history_search_rows';
import createConversationUsage from './2026_10_05_000005_create_conversation_usage';
import createConversationSkillUses from './2026_10_05_000006_create_conversation_skill_uses';
import createConversationMedia from './2026_10_10_000007_create_conversation_media';

export const historyMigrations: Migration[] = [
  createConversationHistorySchema,
  createHistorySearchIndexState,
  removeTaskScope,
  indexHistorySearchRows,
  createConversationUsage,
  createConversationSkillUses,
  createConversationMedia
];
