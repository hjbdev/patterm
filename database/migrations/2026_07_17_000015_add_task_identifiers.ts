import type { Migration } from '../../app/Database/Migration';
import { availableProjectKey } from '../../app/Services/TaskIdentityService';

interface ProjectRow { id: string; name: string }
interface TaskRow { id: string; project_id: string }

export default {
  name: '2026_07_17_000015_add_task_identifiers',
  up(schema) {
    addColumn(schema, `alter table projects add column identifier_key text`);
    addColumn(schema, `alter table projects add column next_task_number integer not null default 1`);
    addColumn(schema, `alter table tasks add column number integer`);

    const projects = schema.connection.prepare(`select id, name from projects order by created_at asc, id asc`).all() as ProjectRow[];
    const usedKeys = new Set<string>();
    for (const project of projects) {
      const key = availableProjectKey(project.name, usedKeys);
      usedKeys.add(key);
      schema.connection.prepare(`update projects set identifier_key = ? where id = ?`).run(key, project.id);
    }

    const tasks = schema.connection
      .prepare(`select id, project_id from tasks order by project_id asc, created_at asc, id asc`)
      .all() as TaskRow[];
    const nextByProject = new Map<string, number>();
    for (const task of tasks) {
      const number = nextByProject.get(task.project_id) ?? 1;
      schema.connection.prepare(`update tasks set number = ? where id = ?`).run(number, task.id);
      nextByProject.set(task.project_id, number + 1);
    }
    for (const project of projects) {
      schema.connection.prepare(`update projects set next_task_number = ? where id = ?`).run(nextByProject.get(project.id) ?? 1, project.id);
    }

    schema.sql(`create unique index if not exists projects_identifier_key_unique on projects(identifier_key collate nocase)`);
    schema.sql(`create unique index if not exists tasks_project_number_unique on tasks(project_id, number)`);
  },
  down() {
    // Additive SQLite migration; leave identifiers in place on rollback.
  }
} satisfies Migration;

function addColumn(schema: Parameters<Migration['up']>[0], statement: string): void {
  try {
    schema.sql(statement);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error;
  }
}
