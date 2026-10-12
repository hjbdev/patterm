import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { caseInsensitiveEnv, envValue, withEnv } from '../app/Platform/Environment';
import { cmdCommand, findExecutable, readCmdShim, resolveCommand } from '../app/Platform/Executable';
import { ipcPath } from '../app/Platform/Ipc';
import { isPathWithin, pathKey, samePath } from '../app/Platform/Paths';
import { killProcessTree } from '../app/Platform/ProcessTree';
import { commandFromShellArgv, defaultShell, shellArgv } from '../app/Platform/Shell';

const windows = process.platform === 'win32';
// Arguments that cmd.exe, PowerShell, or the C runtime would otherwise mangle.
const TRICKY = ['two words "quoted" back\\slash', '', 'trailing\\', 'a&b|c<d>e^f%PATH%!x!', '(parens) [brackets], semi;colon'];

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-platform-'));
  try {
    shellArguments();
    ipcNames(tempDir);
    paths(tempDir);
    if (windows) {
      environment();
      executables(tempDir);
      await processTree();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('platform smoke passed');
}

function shellArguments(): void {
  for (const shell of ['/bin/bash', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell']) {
    assert.equal(commandFromShellArgv(shellArgv(shell, ' npm run dev ')), 'npm run dev', `${shell} command round trip`);
    assert.equal(commandFromShellArgv(shellArgv(shell)), '', `${shell} interactive shell has no command`);
  }
  assert.deepEqual(shellArgv('/bin/zsh', 'make'), ['/bin/zsh', '-lc', 'make']);
  assert.deepEqual(shellArgv('pwsh.exe', 'make'), ['pwsh.exe', '-NoLogo', '-Command', 'make']);
  const shell = defaultShell();
  if (windows) assert.match(path.basename(shell).toLowerCase(), /^(pwsh|powershell)\.exe$/, 'Windows defaults to PowerShell');
}

function ipcNames(tempDir: string): void {
  const socket = path.join(tempDir, 'mcp.sock');
  assert.equal(ipcPath(socket), ipcPath(socket), 'IPC names are stable');
  if (!windows) {
    assert.equal(ipcPath(socket), socket, 'POSIX listens on the socket path');
    return;
  }
  assert.match(ipcPath(socket), /^\\\\\.\\pipe\\patterm-[0-9a-f]{32}-mcp\.sock$/);
  assert.notEqual(ipcPath(socket), ipcPath(path.join(tempDir, 'other', 'mcp.sock')), 'data directories get distinct pipes');
  assert.equal(ipcPath(socket.toUpperCase()), ipcPath(socket), 'pipe names ignore path case');
}

function paths(tempDir: string): void {
  const nested = path.join(tempDir, 'repo', 'src');
  assert.ok(isPathWithin(nested, tempDir));
  assert.ok(isPathWithin(tempDir, tempDir));
  assert.ok(!isPathWithin(`${tempDir}-sibling`, tempDir), 'a sibling with a shared prefix is outside');
  if (windows) {
    assert.ok(samePath(tempDir.toUpperCase(), tempDir), 'Windows paths compare without case');
    assert.ok(samePath(tempDir.replace(/\\/g, '/'), tempDir), 'git-style separators compare equal');
    assert.equal(pathKey('c:\\Repo'), pathKey('C:/repo'));
  }
}

function environment(): void {
  const env = caseInsensitiveEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
  assert.equal(env.PATH, 'C:\\bin', 'PATH reads Path');
  env.PATH = 'C:\\other';
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH'), ['Path'], 'writes keep one key');
  const merged = withEnv({ Path: 'C:\\bin' }, { PATH: 'C:\\new' });
  assert.deepEqual(merged, { PATH: 'C:\\new' }, 'overrides replace differently cased keys');
  assert.equal(envValue({ path: 'x' }, 'PATH'), 'x');
}

function executables(tempDir: string): void {
  const bin = path.join(tempDir, 'bin');
  const pkg = path.join(bin, 'node_modules', 'fake-cli');
  fs.mkdirSync(pkg, { recursive: true });
  const printer = path.join(pkg, 'cli.js');
  fs.writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  // npm installs a POSIX script beside each shim; it must never be chosen.
  fs.writeFileSync(path.join(bin, 'fake-cli'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(bin, 'fake-cli.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\cli.js" %*', ''
  ].join('\r\n'));
  // A batch file that is not a shim goes through cmd.exe.
  fs.writeFileSync(path.join(bin, 'plain.bat'), `@echo off\r\nset "T=${printer}"\r\nnode "%T%" %*\r\n`);

  const env = withEnv(process.env, { PATH: [bin, envValue(process.env, 'PATH')].join(path.delimiter) });
  assert.equal(findExecutable('fake-cli', env), path.join(bin, 'fake-cli.cmd'), 'the .cmd shim is found, not the POSIX script');
  assert.equal(findExecutable('fake-cli.cmd', env), path.join(bin, 'fake-cli.cmd'));
  assert.equal(findExecutable('missing-cli', env), null);

  const shim = readCmdShim(path.join(bin, 'fake-cli.cmd'), env);
  assert.ok(shim, 'npm shim is parsed');
  assert.equal(shim.args[0], printer, 'shim resolves to its script');
  const direct = resolveCommand('fake-cli', TRICKY, env);
  assert.equal(direct.verbatim, false);
  assert.deepEqual(JSON.parse(execFileSync(direct.command, direct.args, { env, encoding: 'utf8' })), TRICKY, 'shim target receives exact args');

  const plain = resolveCommand('plain', TRICKY, env);
  assert.equal(plain.verbatim, true, 'other batch files run through cmd.exe');
  assert.deepEqual(plain, cmdCommand(path.join(bin, 'plain.bat'), TRICKY, env));
  const output = spawnSync(plain.command, plain.args, { env, encoding: 'utf8', windowsVerbatimArguments: true }).stdout;
  assert.deepEqual(JSON.parse(output), TRICKY, 'cmd.exe passes escaped args through');
}

async function processTree(): Promise<void> {
  // A parent whose child would outlive a plain kill().
  const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const children = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent.pid}").ProcessId`], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number);
  assert.equal(children.length, 1, 'the parent started a child');
  await killProcessTree(parent.pid!);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(children[0]!, 0), 'the child ends with its parent');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
