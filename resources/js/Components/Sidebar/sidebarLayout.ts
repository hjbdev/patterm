import { reactive, watch } from 'vue';

// How the sidebar sits on this device: collapsed to the rail or not, its
// width, and the overlays it opens on narrow windows and phones.
const COLLAPSED_KEY = 'patterm.sidebar.collapsed';
const WIDTH_KEY = 'patterm.sidebar.width';

// Resizable widths, in CSS pixels. Stored per device, like the session context panel.
export const SIDEBAR_WIDTH = { min: 220, max: 440, default: 288 } as const;

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

function storedWidth(): number {
  const width = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(width) && width > 0 ? clampSidebarWidth(width) : SIDEBAR_WIDTH.default;
}

export const sidebarLayout = reactive({
  collapsed: localStorage.getItem(COLLAPSED_KEY) === '1',
  width: storedWidth(),
  // The sidebar over the workspace when the window is too narrow to dock it.
  drawerOpen: false,
  mobileOpen: false
});

watch(() => sidebarLayout.collapsed, (collapsed) => localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'));
watch(() => sidebarLayout.width, (width) => localStorage.setItem(WIDTH_KEY, String(width)));
