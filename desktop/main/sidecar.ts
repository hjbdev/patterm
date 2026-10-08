import path from 'node:path';

export function isInstalledLaunch(): boolean {
  return Boolean(process.env.PATTERM_DESKTOP_RESOURCES);
}

function resolveInstalledResourcePath(...segments: string[]): string | null {
  const resourcesPath = process.env.PATTERM_DESKTOP_RESOURCES;

  if (!resourcesPath) {
    return null;
  }

  return path.join(resourcesPath, ...segments);
}

export function resolveSidecarPath(isPackaged: boolean): string {
  const binary = process.platform === 'win32' ? 'patterm-terminal-core.exe' : 'patterm-terminal-core';
  const installedPath = resolveInstalledResourcePath('native', binary);

  if (installedPath) {
    return installedPath;
  }

  if (isPackaged) {
    return path.join(process.resourcesPath, 'native', binary);
  }

  return path.join(process.cwd(), 'native', 'terminal-core', 'target', 'debug', binary);
}

// The MCP stdio shim that launched harnesses run (esbuild output, see build:mcp).
export function resolveMcpShimPath(isPackaged: boolean): string {
  const installedPath = resolveInstalledResourcePath('mcp', 'patterm-mcp.js');

  if (installedPath) {
    return installedPath;
  }

  if (isPackaged) {
    return path.join(process.resourcesPath, 'mcp', 'patterm-mcp.js');
  }

  return path.join(process.cwd(), 'dist', 'mcp', 'patterm-mcp.js');
}
