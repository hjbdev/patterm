import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Native radio inputs styled like the radio buttons in Settings.
export const RADIO_CLASS = 'mt-0.5 h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-full border border-white/25 transition-[border-width,border-color] checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
