import { z } from 'zod';

// How the sidebar and the top bar arrange one scope's tabs: a project's, or
// All agents'. `order` lists tab keys (`agent:<id>`, `process:<id>`) and
// folders (`folder:<id>`) in the order they show; a tab filed in a folder
// shows inside it instead, in the order `order` gives. Clients send the whole
// layout with the revision they edited, so an edit made on a stale copy is
// refused rather than undoing another client's.

export const TAB_FOLDER_LIMIT = 50;
const KEY_LIMIT = 4000;

const keyInput = z.string().min(1).max(400);
export const tabFolderInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(60),
  // Grouped by project, the project an empty folder was last put in.
  project: z.string().min(1).max(200).optional()
}).strict();
export const tabLayoutBody = z.object({
  order: z.array(keyInput).max(KEY_LIMIT),
  folders: z.array(tabFolderInput).max(TAB_FOLDER_LIMIT),
  filed: z.record(keyInput, z.string().min(1).max(64))
}).strict();
export type TabFolder = z.infer<typeof tabFolderInput>;
export type TabLayoutBody = z.infer<typeof tabLayoutBody>;
export interface StoredTabLayout extends TabLayoutBody { revision: number }

const scopeInput = z.string().min(1).max(200);
export const tabLayoutGetInput = z.object({ scope: scopeInput }).strict();
export const tabLayoutSaveInput = tabLayoutBody.extend({ scope: scopeInput, base_revision: z.number().int().min(0) }).strict();

export const storedTabLayoutsInput = z.record(scopeInput, tabLayoutBody.extend({ revision: z.number().int().min(1) }));
export type StoredTabLayouts = z.infer<typeof storedTabLayoutsInput>;

export const EMPTY_STORED_TAB_LAYOUT: StoredTabLayout = { revision: 0, order: [], folders: [], filed: {} };

export function folderKey(id: string): string {
  return `folder:${id}`;
}

// One entry per key; every folder in the order once, and only folders that
// exist; tabs filed only in folders that exist.
export function normalizeTabLayout(layout: TabLayoutBody): TabLayoutBody {
  const folders = [...new Map(layout.folders.map((folder) => [folder.id, folder])).values()];
  const ids = new Set(folders.map((folder) => folder.id));
  const order = [...new Set(layout.order)].filter((key) => !key.startsWith('folder:') || ids.has(key.slice('folder:'.length)));
  for (const folder of folders) if (!order.includes(folderKey(folder.id))) order.push(folderKey(folder.id));
  const filed = Object.fromEntries(Object.entries(layout.filed).filter(([key, id]) => ids.has(id) && !key.startsWith('folder:')));
  return { order, folders, filed };
}
