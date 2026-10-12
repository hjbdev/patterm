import assert from 'node:assert/strict';
import { openSqliteConnection } from '../app/Database/SqliteConnection';
import { endsWithSeparator, nativePath, pathColumn, pathContains, pathIdentity, pathParam, pathsMatch, slashPath, storedPath } from '../app/Platform/PathIdentity';
import { skillUsesFromMessages } from '../app/Services/AgentHistory/HistoryAdapterUtils';
import type { ParsedMessage } from '../app/Services/AgentHistory/AgentHistoryTypes';

function main(): void {
  if (process.platform === 'win32') {
    assert.equal(storedPath('c:/Users/x/'), 'C:\\Users\\x');
    assert.ok(pathsMatch('C:\\Users\\X', 'c:/users/x'));
    assert.ok(!pathsMatch('C:\\Users\\X', 'C:\\Users\\Y'));
    assert.ok(pathsMatch(null, null));
    assert.ok(!pathsMatch(null, 'C:\\x'));
    assert.equal(pathIdentity('C:/Users/X'), 'c:\\users\\x');
    assert.ok(pathContains('C:\\Users\\x', 'c:/users/X/src'));
    assert.ok(pathContains('C:\\Users\\x', 'C:\\Users\\x'));
    assert.ok(!pathContains('C:\\Users\\x', 'C:\\Users\\xylophone'), 'a sibling sharing a prefix is not inside');
    assert.equal(nativePath('/c/Users/x'), 'C:\\Users\\x');
    assert.equal(nativePath('/c'), 'C:\\');
    assert.equal(nativePath('/cygdrive/d/work/app'), 'D:\\work\\app');
    assert.equal(nativePath('\\\\?\\C:\\Users\\x'), 'C:\\Users\\x');
    assert.equal(nativePath('C:/Users/x'), 'C:/Users/x', 'native spellings pass through');
    assert.equal(pathParam('C:/Users/X/'), 'c:\\users\\x');
    assert.equal(pathColumn('cwd'), 'patterm_path_key(cwd)');
    const db = openSqliteConnection(':memory:');
    db.exec("create table paths (path text); insert into paths values ('C:\\Users\\Jörg/Repo')");
    const match = db.prepare(`select count(*) as n from paths where ${pathColumn('path')} = ?`).get(pathParam('c:/users/JÖRG/repo')) as { n: number };
    assert.equal(match.n, 1, 'SQL folds non-ASCII case like pathsMatch()');
    db.close();
    assert.equal(slashPath('src\\app\\main.ts'), 'src/app/main.ts');
    assert.ok(endsWithSeparator('src\\') && endsWithSeparator('src/') && !endsWithSeparator('src'));
  } else {
    assert.equal(storedPath('/home/x/'), '/home/x/');
    assert.equal(pathIdentity('/Home/X'), '/Home/X');
    assert.ok(pathsMatch('/home/x', '/home/x'));
    assert.ok(!pathsMatch('/home/x', '/home/X'));
    assert.ok(pathContains('/home/x', '/home/x/src'));
    assert.ok(!pathContains('/home/x', '/home/xylophone'));
    assert.equal(nativePath('/c/Users/x'), '/c/Users/x');
    assert.equal(pathColumn('cwd'), 'cwd');
    assert.equal(pathParam('/home/X'), '/home/X');
    assert.equal(slashPath('src\\app'), 'src\\app');
    assert.ok(endsWithSeparator('src/') && !endsWithSeparator('src\\'));
  }

  // Codex on Windows reads SKILL.md with PowerShell; the JSON arguments double the backslashes.
  const call = (toolInputSummary: string): ParsedMessage => ({ kind: 'tool_call', toolName: 'shell_command', toolInputSummary, turnId: 't1' }) as ParsedMessage;
  const names = (command: string) => skillUsesFromMessages([call(command)], { skillFileReads: true }).map((use) => use.name);
  assert.deepEqual(names('{"command":"Get-Content C:\\\\Users\\\\new\\\\.codex\\\\skills\\\\review\\\\SKILL.md"}'), ['review'], 'a Windows path with a \\n-looking segment');
  assert.deepEqual(names('{"command":"cat /home/x/.codex/skills/deploy/SKILL.md"}'), ['deploy']);
  assert.deepEqual(names('{"command":"Get-ChildItem C:\\\\Users\\\\x\\\\.codex\\\\skills\\\\review\\\\SKILL.md"}'), [], 'listing is not a read');

  // eslint-disable-next-line no-console
  console.log('path identity smoke ok');
}

main();
