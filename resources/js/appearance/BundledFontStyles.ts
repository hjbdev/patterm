import { registerBundledFontLoader } from './FontLoading';

// Registers on-demand Vite CSS chunk loaders for the bundled font families so
// only the active UI and terminal fonts inject @font-face rules at runtime.
const BUNDLED_FONT_LOADERS: Record<string, () => Promise<unknown>> = {
  inter: () => import('../assets/fonts/inter.css'),
  geist: () => import('../assets/fonts/geist.css'),
  'fira sans': () => import('../assets/fonts/fira-sans.css'),
  'ibm plex sans': () => import('../assets/fonts/ibm-plex-sans.css'),
  'geist mono': () => import('../assets/fonts/geist-mono.css'),
  'fira code': () => import('../assets/fonts/fira-code.css'),
  iosevka: () => import('../assets/fonts/iosevka.css'),
  'ibm plex mono': () => import('../assets/fonts/ibm-plex-mono.css'),
  'source code pro': () => import('../assets/fonts/source-code-pro.css'),
  'comic mono': () => import('../assets/fonts/comic-mono.css'),
  'jetbrains mono': () => import('../assets/fonts/jetbrains-mono.css')
};

registerBundledFontLoader((familyName) => BUNDLED_FONT_LOADERS[familyName]?.() ?? null);
