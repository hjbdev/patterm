import { reactive } from 'vue';

const OPEN_KEY = 'patterm.assistant.open';
const EXPANDED_KEY = 'patterm.assistant.expanded';
const DOCKED_KEY = 'patterm.assistant.docked';
const FOLLOW_KEY = 'patterm.assistant.follow';

// How this device shows the assistant: a floating panel, a column docked
// beside the workspace, or a page over it. Shared with the workbench, which
// narrows to make room for the docked column.
export const assistantLayout = reactive({
  open: localStorage.getItem(OPEN_KEY) === '1',
  expanded: localStorage.getItem(EXPANDED_KEY) === '1',
  docked: localStorage.getItem(DOCKED_KEY) === '1',
  follow: localStorage.getItem(FOLLOW_KEY) === '1'
});

export function setAssistantLayout(change: Partial<typeof assistantLayout>): void {
  Object.assign(assistantLayout, change);
  const keys = { open: OPEN_KEY, expanded: EXPANDED_KEY, docked: DOCKED_KEY, follow: FOLLOW_KEY } as const;
  for (const [name, value] of Object.entries(change)) localStorage.setItem(keys[name as keyof typeof keys], value ? '1' : '0');
}
