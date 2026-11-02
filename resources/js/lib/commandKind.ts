// A command palette command's kind for telemetry, without the record IDs and
// names its ID carries: navigate:agent for navigate:agent:<project>:<session>.
// Harness names stay, as in spawn:agent:claude.
export function commandKind(id: string): string {
  const [scope = '', action = '', harness = ''] = id.split(':');
  const word = (part: string) => /^[a-z][a-z-]*$/.test(part);
  if (!word(scope)) return 'unknown';
  if (scope === 'spawn' && action === 'agent' && word(harness)) return `spawn:agent:${harness}`;
  return word(action) ? `${scope}:${action}` : scope;
}
