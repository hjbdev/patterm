// Row actions appear on hover or focus; touch screens always show them.
export const ROW_ACTION = 'h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100';

// Section add buttons. The negative margin lines them up with the row actions below.
export const SECTION_ADD = '-mr-1 ml-auto h-6 w-6 text-muted-foreground/70 hover:text-foreground';

// Empty sections recede so the ones in use stand out.
export function sectionHeading(count: number): string {
  return count ? 'text-muted-foreground' : 'text-muted-foreground/60';
}
