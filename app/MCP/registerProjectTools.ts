import { removeProjectInput, type RemoveProjectAction } from '../Actions/RemoveProjectAction';
import { renameProjectInput, type RenameProjectAction } from '../Actions/RenameProjectAction';
import type { McpToolRegistry } from './ToolRegistry';

// Owner-only project management. Both are hidden, so agents can neither
// rename nor remove a project.
export function registerProjectTools(registry: McpToolRegistry, actions: { rename: RenameProjectAction; remove: RemoveProjectAction }) {
  registry.register(
    {
      name: 'project_rename',
      namespace: 'project',
      hidden: true,
      changes: ['workbench', 'routines'],
      description: 'Rename a project. Its folder is not renamed.',
      inputSchema: { type: 'object', required: ['project_id', 'name'] }
    },
    (args) => actions.rename.execute(renameProjectInput.parse(args))
  );

  registry.register(
    {
      name: 'project_remove',
      namespace: 'project',
      hidden: true,
      changes: ['workbench', 'routines', 'settings', 'context', 'history'],
      description: 'Remove a project and everything Patterm holds for it, stopping its agents and processes first. Files on disk are not touched.',
      inputSchema: { type: 'object', required: ['project_id'] }
    },
    (args) => actions.remove.execute(removeProjectInput.parse(args))
  );
}
