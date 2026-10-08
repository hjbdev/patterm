import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  define: {
    __PATTERM_VERSION__: JSON.stringify(version)
  },
  plugins: [vue()],
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
    strictPort: true
  }
});
