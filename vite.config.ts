import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';
import { FIGURE_FONT_SUBSETS, FIGURE_FONT_WEIGHTS, figureFontFile } from './app/Services/HtmlFigure';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The desktop app's page previews read Inter from the build, under stable names.
function figureFonts(): Plugin {
  return {
    name: 'patterm-figure-fonts',
    apply: 'build',
    writeBundle(options) {
      const target = `${options.dir ?? 'dist/renderer'}/figure-fonts`;
      mkdirSync(target, { recursive: true });
      for (const subset of Object.keys(FIGURE_FONT_SUBSETS) as Array<keyof typeof FIGURE_FONT_SUBSETS>) {
        for (const weight of FIGURE_FONT_WEIGHTS) {
          const file = figureFontFile(subset, weight);
          copyFileSync(fileURLToPath(new URL(`./resources/js/assets/fonts/inter/${file}`, import.meta.url)), `${target}/${file}`);
        }
      }
    }
  };
}

export default defineConfig({
  base: './',
  define: {
    __PATTERM_VERSION__: JSON.stringify(version)
  },
  plugins: [vue(), figureFonts()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./resources/js', import.meta.url)) },
      // Shiki's full bundle includes GPL-3.0 grammars. Every `shiki` import,
      // including @pierre/diffs', gets Patterm's allowlisted bundle instead.
      { find: /^shiki$/, replacement: fileURLToPath(new URL('./resources/js/lib/shiki.ts', import.meta.url)) }
    ]
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true
  },
  // Pierre's highlighting workers load Shiki's WASM engine on demand, which
  // needs a code-splitting module worker.
  worker: {
    format: 'es'
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Worktrees and build output hold other checkouts and running binaries.
    // Windows refuses to watch a running .exe, which would crash the server.
    watch: {
      ignored: ['**/.worktrees/**', '**/.claude/**', '**/native/terminal-core/target/**', '**/dist/**']
    }
  }
});
