# Bundled fonts

The WOFF2 files are unmodified font binaries from the pinned Fontsource npm
packages listed in manifest.json. Each family keeps all upstream language
subsets for the included weights. The adjacent CSS retains their unicode ranges.
Interface families include regular, medium, semibold and bold, with italics
where upstream supplies them. Terminal families include regular and bold with
italics where available (Fira Code and Comic Mono have no italic faces).

Licences and copyright notices are in scripts/third-party-licences/*.FONT-LICENSE
and included by scripts/third-party-notices.mjs in the offline About notices.
No fonts are fetched from an external service at runtime. Vite emits the assets
for both Electron and the browser server; browsers download selected families.

JetBrains Mono Nerd Font is an installed-font option only. Nerd Fonts v3.5.1
lists its embedded Font Logos set as unlicensed in its licence audit:
https://github.com/ryanoasis/nerd-fonts/blob/v3.5.1/license-audit.md
Its fallback is the bundled original JetBrains Mono. Comic Code is not bundled;
users with a local installation can select it through Custom.
