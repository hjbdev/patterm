# Security

Patterm runs agent CLIs with your user's permissions, and its background
service can be reached over Tailscale. Please report vulnerabilities privately.

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's Security tab. This opens a
private advisory that only the maintainers can see. Please don't open a public
issue for a security problem.

Include the Patterm version (from `~/.local/share/patterm/current/BUILD` or Settings ›
About), how Patterm is installed and reached (desktop, background service, or
Tailscale Serve), and the steps to reproduce.

## Supported versions

Security fixes go into the latest stable release. Pre-releases are untested
builds and may not receive fixes.

## Scope

In scope: the background service's HTTP and WebSocket endpoints, the browser
client, the MCP socket and shim, the installers, and release signing.

Out of scope: vulnerabilities in the agent CLIs Patterm hosts, and anything
that needs an attacker who can already run commands as your user.
