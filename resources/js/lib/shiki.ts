// Shiki's full bundle includes GPL-3.0 grammars and themes, so Patterm builds
// its own from the languages below and the github-dark theme. vite.config.ts
// resolves every `shiki` import here, including @pierre/diffs', so no other
// grammar reaches the build. Code in other languages shows as plain text.
// Check a grammar's licence in Shiki's tm-grammars table before adding it,
// including the grammars it imports.
import {
  createBundledHighlighter,
  createSingletonShorthands,
  guessEmbeddedLanguages,
  type DynamicImportLanguageRegistration,
  type DynamicImportThemeRegistration
} from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

export * from 'shiki/core';
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
export { createOnigurumaEngine };

const languages = {
  astro: () => import('shiki/langs/astro.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  blade: () => import('shiki/langs/blade.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  elm: () => import('shiki/langs/elm.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  fsharp: () => import('shiki/langs/fsharp.mjs'),
  'git-commit': () => import('shiki/langs/git-commit.mjs'),
  'git-rebase': () => import('shiki/langs/git-rebase.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsonl: () => import('shiki/langs/jsonl.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  log: () => import('shiki/langs/log.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  nushell: () => import('shiki/langs/nushell.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  ocaml: () => import('shiki/langs/ocaml.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  regexp: () => import('shiki/langs/regexp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  solidity: () => import('shiki/langs/solidity.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  tex: () => import('shiki/langs/tex.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
} satisfies Record<string, DynamicImportLanguageRegistration>;

export const bundledLanguages: Record<string, DynamicImportLanguageRegistration> = {
  ...languages,
  batch: languages.bat,
  cmd: languages.bat,
  clj: languages.clojure,
  'c++': languages.cpp,
  'c#': languages.csharp,
  cs: languages.csharp,
  dockerfile: languages.docker,
  erl: languages.erlang,
  'f#': languages.fsharp,
  fs: languages.fsharp,
  gql: languages.graphql,
  hs: languages.haskell,
  properties: languages.ini,
  js: languages.javascript,
  cjs: languages.javascript,
  mjs: languages.javascript,
  jl: languages.julia,
  kt: languages.kotlin,
  kts: languages.kotlin,
  makefile: languages.make,
  md: languages.markdown,
  nu: languages.nushell,
  objc: languages['objective-c'],
  ps: languages.powershell,
  ps1: languages.powershell,
  pwsh: languages.powershell,
  protobuf: languages.proto,
  py: languages.python,
  regex: languages.regexp,
  rb: languages.ruby,
  rs: languages.rust,
  bash: languages.shellscript,
  sh: languages.shellscript,
  shell: languages.shellscript,
  zsh: languages.shellscript,
  ts: languages.typescript,
  cts: languages.typescript,
  mts: languages.typescript,
  yml: languages.yaml,
};

export const bundledThemes: Record<string, DynamicImportThemeRegistration> = {
  'github-dark': () => import('shiki/themes/github-dark.mjs')
};

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createOnigurumaEngine(import('shiki/wasm'))
});

export const { codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } =
  createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
