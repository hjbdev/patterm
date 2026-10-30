// Row actions appear on hover or focus; touch screens always show them.
export const ROW_ACTION = 'h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100';

// Section add buttons. The negative margin lines them up with the row actions below.
export const SECTION_ADD = '-mr-1 ml-auto h-6 w-6 text-muted-foreground/70 hover:text-foreground';

// Empty sections recede so the ones in use stand out.
export function sectionHeading(count: number): string {
  return count ? 'text-muted-foreground' : 'text-muted-foreground/60';
}

// Chips in an agent's header, each holding one kind of thing attached to it.
export const CHIP = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 text-[12.5px] text-foreground/85 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/[0.14] data-[state=open]:text-foreground max-sm:h-8 max-sm:rounded-lg max-sm:px-3 max-sm:text-[13px]';
export const CHIP_ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
// Trimmed to cap height so centring centres the letters, not the font's line box;
// the padding gives back room for descenders under truncate's clip.
export const CHIP_LABEL = 'py-1 [text-box:trim-both_cap_alphabetic]';
