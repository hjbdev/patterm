import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('launcher dispatches GUI and headless launches without restarting services', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-launcher-'));
  try {
    for (const dir of ['scripts', 'bin', 'node_modules/.bin']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync('scripts/patterm.sh', path.join(root, 'scripts/patterm.sh'));
    const log = path.join(root, 'calls');
    const stub = (name, text) => fs.writeFileSync(path.join(root, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
    stub('bin/systemctl', 'echo "systemctl $*" >> "$CALLS"\nif [[ "$2" == cat ]]; then exit "${UNIT_MISSING:-0}"; fi');
    stub('bin/node', 'echo "node $*" >> "$CALLS"');
    stub('node_modules/.bin/electron', 'echo "electron $*" >> "$CALLS"\n[[ -z "${ELECTRON_RUN_AS_NODE:-}" ]]');
    const run = (args, extra = {}) => {
      fs.writeFileSync(log, '');
      const result = spawnSync('bash', [path.join(root, 'scripts/patterm.sh'), ...args], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: log,
          PATTERM_PUBLIC_ORIGIN: 'http://localhost:8787', ELECTRON_RUN_AS_NODE: '1', ...extra },
      });
      return { ...result, calls: fs.readFileSync(log, 'utf8') };
    };
    let result = run(['--headless']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, 'systemctl --user cat patterm.service\nsystemctl --user start patterm.service\n');
    result = run(['--headless'], { UNIT_MISSING: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, `systemctl --user cat patterm.service\nnode ${root}/scripts/install-service.mjs --public-origin http://localhost:8787\nsystemctl --user daemon-reload\nsystemctl --user start patterm.service\n`);
    result = run(['--headless', 'unexpected']);
    assert.equal(result.status, 1);
    assert.equal(result.calls, '');
    result = run(['--headless', '--tailscale-serve']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, `node ${root}/scripts/start-tailscale-service.mjs\n`);
    result = run(['--tailscale-serve']);
    assert.equal(result.status, 1);
    assert.equal(result.calls, '');
    result = run(['--help']);
    assert.equal(result.status, 0);
    assert.equal(result.calls, '');
    result = run(['--disable-gpu']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, `electron ${root}/dist/main/desktop/main/main.js --disable-gpu\n`);
    // A release tarball's bundled runtimes win over PATH and node_modules.
    for (const dir of ['runtime', 'electron']) fs.mkdirSync(path.join(root, dir));
    stub('runtime/node', 'echo "bundled-node $*" >> "$CALLS"');
    stub('electron/electron', 'echo "bundled-electron $*" >> "$CALLS"\n[[ -z "${ELECTRON_RUN_AS_NODE:-}" ]]');
    result = run(['--headless'], { UNIT_MISSING: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, new RegExp(`^bundled-node ${root}/scripts/install-service.mjs `, 'm'));
    result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, `bundled-electron ${root}/dist/main/desktop/main/main.js\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updates stage before stopping the app and preserve terminal hosts and installed settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-update-'));
  try {
    const source = path.join(root, 'source');
    const home = path.join(root, 'home');
    const installed = path.join(home, '.local/share/patterm-desktop');
    const data = path.join(root, 'server-data');
    const configHome = path.join(home, '.config');
    for (const directory of ['scripts', 'deploy', 'dist/mcp', 'dist/server/server', 'dist/renderer', 'node_modules/.bin', 'native/terminal-core/target/debug', 'native/terminal-core/target/release']) {
      fs.mkdirSync(path.join(source, directory), { recursive: true });
    }
    for (const file of ['install.sh', 'update.sh', 'scripts/install-service.mjs', 'scripts/patterm.sh', 'scripts/start-tailscale-service.mjs', 'deploy/patterm.service', 'deploy/patterm-terminal@.service']) {
      fs.copyFileSync(file, path.join(source, file));
    }
    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"new"}\n');
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.writeFileSync(path.join(source, file), 'notice');
    for (const file of ['dist/mcp/patterm-mcp.js', 'dist/server/server/main.js', 'dist/renderer/index.html']) fs.writeFileSync(path.join(source, file), 'new');
    const executable = (filename, script) => fs.writeFileSync(filename, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    executable(path.join(source, 'node_modules/.bin/electron'), 'exit 0');
    for (const profile of ['debug', 'release']) executable(path.join(source, `native/terminal-core/target/${profile}/patterm-terminal-core`), `echo ${profile}`);
    executable(path.join(source, 'build.sh'), 'echo "build $*" >> "$CALLS"\nexit "${BUILD_STATUS:-0}"');
    fs.mkdirSync(path.join(root, 'bin'));
    executable(path.join(root, 'bin/pnpm'), 'echo "pnpm $*" >> "$CALLS"\nexit "${SERVER_BUILD_STATUS:-0}"');
    executable(path.join(root, 'bin/systemctl'), 'echo "systemctl $*" >> "$CALLS"\nif [[ "$2" == start ]]; then exit "${START_STATUS:-0}"; fi');
    executable(path.join(root, 'bin/update-desktop-database'), 'exit 0');
    executable(path.join(root, 'bin/curl'), 'echo "curl ${@: -1}" >> "$CALLS"\nexit "${HEALTH_STATUS:-0}"');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'old-app'), 'retained until update succeeds');
    fs.mkdirSync(path.join(data, 'terminal-hosts/old'), { recursive: true });
    fs.writeFileSync(path.join(data, 'terminal-hosts/old/terminal-core'), 'running old host');
    fs.mkdirSync(path.join(configHome, 'patterm'), { recursive: true });
    const envFile = path.join(configHome, 'patterm/patterm.env');
    fs.writeFileSync(envFile, `PATTERM_PORT="9797"\nPATTERM_PUBLIC_ORIGIN="http://localhost:9797"\nPATTERM_DATA_DIR="${data}"\n`);
    const log = path.join(root, 'calls');
    const run = (extra = {}, args = []) => {
      fs.writeFileSync(log, '');
      const result = spawnSync('bash', [path.join(source, 'update.sh'), ...args], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: configHome, CALLS: log, ...extra }
      });
      return { ...result, calls: fs.readFileSync(log, 'utf8') };
    };
    const failed = run({ BUILD_STATUS: '1' });
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.calls, /systemctl/);
    assert.equal(fs.readFileSync(path.join(installed, 'old-app'), 'utf8'), 'retained until update succeeds');
    assert.notEqual(run({}, ['--verbose']).status, 0);
    fs.renameSync(path.join(source, 'dist/mcp/patterm-mcp.js'), path.join(source, 'dist/mcp/hidden.js'));
    const incomplete = run();
    assert.notEqual(incomplete.status, 0);
    assert.doesNotMatch(incomplete.calls, /systemctl/);
    assert.equal(fs.readFileSync(path.join(installed, 'old-app'), 'utf8'), 'retained until update succeeds');
    fs.renameSync(path.join(source, 'dist/mcp/hidden.js'), path.join(source, 'dist/mcp/patterm-mcp.js'));
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, 'build \nsystemctl --user is-active --quiet patterm.service\nsystemctl --user stop patterm.service\nsystemctl --user daemon-reload\nsystemctl --user start patterm.service\ncurl http://127.0.0.1:9797/health\n');
    assert.equal(fs.readFileSync(path.join(installed, 'dist/server/server/main.js'), 'utf8'), 'new');
    assert.match(fs.readFileSync(path.join(installed, 'resources/native/patterm-terminal-core'), 'utf8'), /release/, 'the desktop app gets the release sidecar by default');
    assert.equal(fs.existsSync(path.join(installed, 'old-app')), false);
    assert.equal(fs.readFileSync(path.join(`${installed}.previous`, 'old-app'), 'utf8'), 'retained until update succeeds');
    assert.match(fs.readFileSync(path.join(installed, 'BUILD'), 'utf8'), /^version=new\ncommit=/);
    assert.equal(fs.readFileSync(path.join(data, 'terminal-hosts/old/terminal-core'), 'utf8'), 'running old host');
    const config = fs.readFileSync(envFile, 'utf8');
    assert.match(config, /^PATTERM_PORT="9797"$/m);
    assert.match(config, /^PATTERM_TERMINAL_SERVICE="patterm-terminal"$/m);
    assert.ok(config.includes(`PATTERM_DATA_DIR="${data}"`));
    assert.ok(config.includes(`PATTERM_SIDECAR="${installed}/native/terminal-core/target/release/patterm-terminal-core"`));
    assert.ok(fs.existsSync(path.join(configHome, 'systemd/user/patterm-terminal@.service')));
    assert.deepEqual(fs.readdirSync(path.dirname(installed)).sort(), ['applications', 'patterm-desktop', 'patterm-desktop.previous']);
    fs.writeFileSync(path.join(source, 'dist/server/server/main.js'), 'newer');
    result = run({ START_STATUS: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(installed, 'dist/server/server/main.js'), 'utf8'), 'newer');
    assert.match(result.stdout, /Do not run it against migrated databases/);
    const previous = fs.readdirSync(path.dirname(installed)).find((entry) => entry.includes('.staging.') && entry.endsWith('.previous'));
    assert.ok(previous);
    assert.equal(fs.readFileSync(path.join(path.dirname(installed), previous, 'dist/server/server/main.js'), 'utf8'), 'new');
    assert.ok(result.stderr.includes(`with ${path.join(path.dirname(installed), previous)} and`), 'a failed start points the rollback at the build it replaced');
    assert.equal(result.calls.match(/systemctl --user start/g).length, 1);
    fs.rmSync(path.join(path.dirname(installed), previous), { recursive: true });
    fs.writeFileSync(path.join(source, 'dist/server/server/main.js'), 'newest');
    // A service that starts but never serves keeps the replaced build for a rollback.
    result = run({ HEALTH_STATUS: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not healthy at http:\/\/127\.0\.0\.1:9797\/health/);
    assert.match(result.stderr, /To roll back/);
    assert.equal(fs.readFileSync(path.join(`${installed}.previous`, 'dist/server/server/main.js'), 'utf8'), 'newer');
    result = run({}, ['--debug']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /^build --debug\n/);
    assert.match(fs.readFileSync(path.join(installed, 'resources/native/patterm-terminal-core'), 'utf8'), /debug/, '--debug keeps the debug sidecar for the desktop app');
    assert.ok(fs.readFileSync(envFile, 'utf8').includes(`PATTERM_SIDECAR="${installed}/native/terminal-core/target/release/patterm-terminal-core"`), 'the service keeps the release sidecar');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
