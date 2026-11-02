import { cpSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite-plus';
import { BUNDLED_FIGURE_FONTS } from './app/Services/HtmlFigure';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The desktop app's page previews read the bundled faces from the build,
// under stable names: the Latin ones, which pages carry inline.
function figureFonts(): Plugin {
  return {
    name: 'patterm-figure-fonts',
    apply: 'build',
    writeBundle(options) {
      for (const slug of BUNDLED_FIGURE_FONTS) {
        cpSync(fileURLToPath(new URL(`./resources/js/assets/fonts/${slug}`, import.meta.url)), `${options.dir ?? 'dist/renderer'}/figure-fonts/${slug}`, {
          recursive: true,
          filter: (source) => !source.endsWith('.woff2') || /-latin(-ext)?-[4-7]00-normal\.woff2$/.test(source)
        });
      }
    }
  };
}

// Every app component's name, for the telemetry inventory that lists the
// components nobody opens. shadcn-vue primitives are left out.
function componentInventory(): Plugin {
  const id = 'virtual:patterm-components';
  const root = fileURLToPath(new URL('./resources/js', import.meta.url));
  return {
    name: 'patterm-component-inventory',
    resolveId: (source) => source === id ? `\0${id}` : null,
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const names = readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.vue') && !file.split(/[\\/]/).includes('ui'))
        .map((file) => path.basename(file, '.vue'));
      return `export default ${JSON.stringify([...new Set(names)].sort())};`;
    }
  };
}

export default defineConfig({
  base: './',
  define: {
    __PATTERM_VERSION__: JSON.stringify(version)
  },
  plugins: [vue(), figureFonts(), componentInventory()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./resources/js', import.meta.url)) },
      // Shiki's full bundle includes GPL-3.0 grammars. Every `shiki` import,
      // including @pierre/diffs', gets Patterm's allowlisted bundle instead.
      { find: /^shiki$/, replacement: fileURLToPath(new URL('./resources/js/lib/shiki.ts', import.meta.url)) }
    ]
  },
  build: {
    // Preserve the browser targets used before the Vite+ upgrade.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
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
