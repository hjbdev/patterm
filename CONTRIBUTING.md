# Contributing

Bug reports and feature requests are welcome as GitHub issues. Please search
existing issues first, and include your Patterm version, Linux distribution,
and the agent CLIs involved.

Before starting a pull request, open an issue to discuss it. Patterm has firm
design constraints, listed in `AGENTS.md`, and changes outside them are unlikely
to be accepted.

Pull requests must pass the full check:

```sh
pnpm install
pnpm run check
pnpm run build
pnpm run build:server
node --test tests/serviceInstallerSmoke.mjs
```

Update `CHANGELOG.md` for notable changes. After adding or upgrading a
dependency, run `pnpm run notices` and commit `THIRD_PARTY_NOTICES.md`.

Report security problems privately, as described in `SECURITY.md`.

By contributing, you agree that your contributions are licensed under the MIT
licence in `LICENSE`.
