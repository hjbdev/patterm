import type { ProcessRecord } from '../types';

// An agent's servers: the processes it started, each paired with the preview
// link that names its port, then the preview links that pair with none.
export interface ServerEntry {
  key: string;
  label: string;
  port: string | null;
  url: string | null;
  // The paired preview link's status, such as kept.
  status: string | null;
  process: Pick<ProcessRecord, 'id' | 'name' | 'command'> | null;
}

export interface PreviewLink { id: string; url: string; status?: string | null }

// A process's port, from its name (`site :8885`) or its command line.
export function processPort(process: Pick<ProcessRecord, 'name' | 'command'>): string | null {
  return process.name.match(/:(\d{2,5})\s*$/)?.[1]
    ?? process.command.match(/(?:--port[= ]|-p |PORT=|:)(\d{2,5})\b/)?.[1]
    ?? process.command.match(/(?:^|\s)(\d{4,5})(?=\s|$)/)?.[1]
    ?? null;
}

// A link's explicit port; a link on the scheme's own port has none to pair by.
export function linkPort(url: string): string | null {
  try { return new URL(url).port || null; } catch { return null; }
}

// A preview's address without its scheme, as a browser's bar shows it.
export function previewAddress(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
}

// The name without a trailing `:port`, which shows separately.
export function serverLabel(name: string, port: string | null): string {
  return port ? name.replace(new RegExp(`\\s*:${port}\\s*$`), '') || name : name;
}

export function familyServers<P extends Pick<ProcessRecord, 'id' | 'name' | 'command'>, L extends PreviewLink>(
  processes: readonly P[],
  previews: readonly L[],
  linkLabel: (link: L) => string
): (ServerEntry & { process: P | null })[] {
  const unpaired = [...previews];
  const paired = processes.map((process) => {
    const port = processPort(process);
    const index = port ? unpaired.findIndex((link) => linkPort(link.url) === port) : -1;
    const link = index >= 0 ? unpaired.splice(index, 1)[0]! : null;
    return { key: process.id, label: serverLabel(process.name, port), port, url: link?.url ?? null, status: link?.status ?? null, process };
  });
  return [...paired, ...unpaired.map((link) => ({ key: link.id, label: linkLabel(link), port: linkPort(link.url), url: link.url, status: link.status ?? null, process: null }))];
}
