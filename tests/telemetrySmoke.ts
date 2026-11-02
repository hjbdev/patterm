import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { TelemetryService } from '../app/Services/Telemetry/TelemetryService';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { commandKind } from '../resources/js/lib/commandKind';
import { observedRoutes, type RouteRegistrar } from '../routes/application';

async function main(): Promise<void> {
const directory = mkdtempSync(path.join(os.tmpdir(), 'patterm-telemetry-'));
try {
  const database = new DatabaseService(directory);
  database.initialize();
  const settings = new SettingsService(database);
  const requests: Array<{ url: string; body: { api_key: string; batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> } }> = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const telemetry = new TelemetryService({
    settings,
    context: { app_version: 'test', runtime: 'server', os: 'linux' },
    inventory: () => ({ tools: ['b_tool', 'a_tool'], channels: ['patterm:x'], settings: settings.changedSettings(), records: { todos: 3 } }),
    fetch: fetchStub
  });

  // Off by default: nothing is counted or sent.
  assert.deepEqual(telemetry.settings(), { enabled: false, apiKey: '', host: 'us', epoch: null });
  assert.equal(telemetry.enabled, false);
  telemetry.count('tool_called', { tool: 'todo_list' });
  telemetry.capture('feedback', {});
  assert.deepEqual(telemetry.record({ epoch: '00000000-0000-4000-8000-000000000000', clicks: { 'App:button': 1 } }), { accepted: false });
  await telemetry.flush();
  assert.equal(requests.length, 0, 'telemetry that is off sends nothing');

  // Turning it on needs a project key.
  assert.equal(telemetry.update({ enabled: true, apiKey: '', host: 'us' }).enabled, false);
  assert.throws(() => telemetry.update({ enabled: true, apiKey: 'not a key', host: 'us' }));
  telemetry.update({ enabled: true, apiKey: 'phc_test', host: 'eu' });
  assert.equal(telemetry.enabled, true);
  const firstId = settings.telemetrySettings().installId;
  assert.match(firstId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(telemetry.settings().epoch, firstId, 'clients learn the epoch of this opt-in');
  assert.deepEqual(telemetry.record({ epoch: '00000000-0000-4000-8000-000000000000', clicks: { 'App:button': 1 } }), { accepted: false }, 'counts from another opt-in are refused');

  // Repeated calls are sent as one counted event.
  telemetry.count('tool_called', { tool: 'todo_list', caller: 'agent' }, { ok: true, ms: 10 });
  telemetry.count('tool_called', { tool: 'todo_list', caller: 'agent' }, { ok: false, ms: 30 });
  telemetry.record({ epoch: firstId, clicks: { 'DiffDrawer:button': 2, 'key:ctrl+k': 1 }, commands: { 'navigate:agent': 3 }, views: { settings: 1 }, seconds: { settings: 12.4 }, components: ['DiffDrawer', 'AboutSettings'] });
  assert.throws(() => telemetry.record({ epoch: firstId, clicks: { 'My project name': 1 } }), 'clients report identifiers, not text');
  telemetry.feedback({ sentiment: 'dislike', note: 'Too many tabs' });
  await telemetry.flush();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request!.url, 'https://eu.i.posthog.com/batch/');
  assert.equal(request!.body.api_key, 'phc_test');
  const events = request!.body.batch;
  assert.ok(events.every((event) => event.distinct_id === firstId && event.properties.app_version === 'test' && event.properties.$process_person_profile === false && event.properties.$geoip_disable === true));
  const byEvent = (name: string) => events.filter((event) => event.event === name);
  assert.deepEqual(byEvent('feature_inventory')[0]?.properties.tools, ['a_tool', 'b_tool']);
  assert.equal(byEvent('record_counts')[0]?.properties.records_todos, 3);
  assert.equal(byEvent('telemetry_enabled').length, 1);
  const toolCall = byEvent('tool_called')[0]!.properties;
  assert.equal(toolCall.count, 2);
  assert.equal(toolCall.errors, 1);
  assert.equal(toolCall.mean_ms, 20);
  assert.deepEqual(byEvent('ui_clicked').map((event) => [event.properties.feature, event.properties.count]).sort(), [['DiffDrawer:button', 2], ['key:ctrl+k', 1]]);
  assert.equal(byEvent('page_time')[0]?.properties.seconds, 12);
  assert.equal(byEvent('command_run')[0]?.properties.command, 'navigate:agent');
  assert.equal(byEvent('command_run')[0]?.properties.count, 3);
  assert.deepEqual(byEvent('ui_inventory')[0]?.properties.components, ['AboutSettings', 'DiffDrawer']);
  assert.equal(byEvent('feedback')[0]?.properties.note, 'Too many tabs');

  // An empty flush sends nothing.
  await telemetry.flush();
  assert.equal(requests.length, 1);

  // Turning it off forgets the ID and drops anything not yet sent.
  telemetry.count('tool_called', { tool: 'todo_list' });
  telemetry.update({ enabled: false, apiKey: 'phc_test', host: 'eu' });
  assert.equal(settings.telemetrySettings().installId, null);
  await telemetry.flush();
  assert.equal(requests.length, 1);
  telemetry.update({ enabled: true, apiKey: 'phc_test', host: 'us' });
  assert.notEqual(settings.telemetrySettings().installId, firstId, 'each opt-in gets a new ID');

  // Settings changed from their defaults are listed by path only.
  assert.deepEqual(settings.changedSettings(), []);
  settings.updateAppearanceSettings({ ...settings.appearanceSettings(), navigation: 'sidebar', terminalFont: { preset: 'custom', customFamily: 'Secret Font' } });
  assert.deepEqual(settings.changedSettings(), ['appearance.terminalFont.preset', 'appearance.terminalFont.customFamily', 'appearance.navigation']);

  // The registry reports every call by name and caller, including failures.
  const registry = new McpToolRegistry();
  const calls: Array<{ tool: string; caller: string; ok: boolean }> = [];
  registry.register({ name: 'ok_tool', namespace: 'test', description: '', inputSchema: {} }, () => 'done');
  registry.register({ name: 'bad_tool', namespace: 'test', description: '', inputSchema: {} }, () => { throw new Error('nope'); });
  registry.setObserver(({ tool, caller, ok }) => calls.push({ tool, caller, ok }));
  assert.equal(await registry.call('ok_tool', {}), 'done');
  assert.equal(await registry.callPublic('ok_tool', {}, { identity: 'agent' }), 'done');
  await assert.rejects(registry.call('bad_tool', {}, { remote: { host_id: 'h', host_name: 'h', project_id: 'p' } }), /nope/);
  assert.deepEqual(calls, [{ tool: 'ok_tool', caller: 'app', ok: true }, { tool: 'ok_tool', caller: 'agent', ok: true }, { tool: 'bad_tool', caller: 'remote', ok: false }]);
  registry.setObserver(() => { throw new Error('observer failed'); });
  assert.equal(await registry.call('ok_tool', {}), 'done', 'a failing observer never fails the call');

  // Wrapped routes keep their results and errors, list every channel, and
  // count each use, except tool calls and debug logging.
  const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>();
  const base = { handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => { handlers.set(channel, handler); }, on: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => { handlers.set(channel, handler); }, extra: () => 'kept' };
  const routes = observedRoutes<RouteRegistrar & { extra(): string }>(base, telemetry);
  assert.equal(routes.extra(), 'kept', "the registrar's other methods still work");
  routes.handle('patterm:sync', () => 1);
  routes.handle('patterm:async', async () => 2);
  routes.handle('patterm:fails', () => { throw new Error('bad'); });
  routes.on('patterm:mcp:call', () => 3);
  assert.equal(handlers.get('patterm:sync')!(undefined), 1);
  assert.equal(await handlers.get('patterm:async')!(undefined), 2);
  assert.throws(() => handlers.get('patterm:fails')!(undefined), /bad/);
  assert.equal(handlers.get('patterm:mcp:call')!(undefined), 3);
  assert.deepEqual([...telemetry.channels].sort(), ['patterm:async', 'patterm:fails', 'patterm:mcp:call', 'patterm:sync']);
  requests.length = 0;
  await telemetry.flush();
  const channelEvents = requests.flatMap((request) => request.body.batch).filter((event) => event.event === 'channel_called');
  assert.deepEqual(channelEvents.map((event) => [event.properties.channel, event.properties.count, event.properties.errors]).sort(), [['patterm:async', 1, 0], ['patterm:fails', 1, 1], ['patterm:sync', 1, 0]]);

  // Command palette IDs lose the record IDs they carry.
  assert.equal(commandKind('navigate:agent:project_1:session_2'), 'navigate:agent');
  assert.equal(commandKind('goto:5f1d0c2e-1111'), 'goto');
  assert.equal(commandKind('spawn:agent:claude'), 'spawn:agent:claude');
  assert.equal(commandKind('spawn:preset:my_preset'), 'spawn:preset');
  assert.equal(commandKind('renderer:settings'), 'renderer:settings');

  // Quitting during a send still sends what was counted after it began.
  const sent: string[][] = [];
  let release: () => void = () => undefined;
  const slow = new TelemetryService({
    settings,
    context: {},
    inventory: () => ({ tools: [], channels: [], settings: [], records: {} }),
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { batch: Array<{ event: string; properties: { tool?: string } }> };
      sent.push(body.batch.filter((event) => event.event === 'tool_called').map((event) => event.properties.tool ?? ''));
      if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return new Response('{}', { status: 200 });
    }) as typeof fetch
  });
  slow.count('tool_called', { tool: 'first' });
  const pending = slow.flush();
  slow.count('tool_called', { tool: 'second' });
  const disposed = slow.dispose();
  release();
  await pending;
  await disposed;
  assert.deepEqual(sent, [['first'], ['second']]);

  await telemetry.dispose();
  database.dispose();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
}

void main().then(() => console.log('telemetry smoke passed'), (error: unknown) => { console.error(error); process.exitCode = 1; });
