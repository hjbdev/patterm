// Inter's Latin faces as data URLs for agent pages. This module is its own
// chunk, loaded with the first page a conversation shows.

import { figureFontCss, type FigureFontSubset } from '../../../app/Services/HtmlFigure';
import latin400 from '../assets/fonts/inter/inter-latin-400-normal.woff2?inline';
import latin500 from '../assets/fonts/inter/inter-latin-500-normal.woff2?inline';
import latin600 from '../assets/fonts/inter/inter-latin-600-normal.woff2?inline';
import latin700 from '../assets/fonts/inter/inter-latin-700-normal.woff2?inline';
import latinExt400 from '../assets/fonts/inter/inter-latin-ext-400-normal.woff2?inline';
import latinExt500 from '../assets/fonts/inter/inter-latin-ext-500-normal.woff2?inline';
import latinExt600 from '../assets/fonts/inter/inter-latin-ext-600-normal.woff2?inline';
import latinExt700 from '../assets/fonts/inter/inter-latin-ext-700-normal.woff2?inline';

const FACES: Record<FigureFontSubset, Record<number, string>> = {
  latin: { 400: latin400, 500: latin500, 600: latin600, 700: latin700 },
  'latin-ext': { 400: latinExt400, 500: latinExt500, 600: latinExt600, 700: latinExt700 }
};

export const FIGURE_FONT_CSS = figureFontCss((subset, weight) => FACES[subset][weight] ?? null);
