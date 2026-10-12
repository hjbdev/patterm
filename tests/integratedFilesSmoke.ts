import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { UploadService } from '../app/Http/UploadService';
import { IntegratedAgentService, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import type { ResolvedIntegratedPrompt } from '../app/Services/IntegratedInput';
import { WorktreeFileService } from '../app/Services/WorktreeFileService';
import { trySymlink } from './fixtures/SymlinkFixture';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-integrated-files-'));
  const worktree = path.join(directory, 'worktree');
  const uploads = path.join(directory, 'uploads');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(path.join(worktree, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'build'), { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'app.ts'), 'export const app = 1;');
  fs.writeFileSync(path.join(worktree, 'src', 'components', 'button.ts'), 'export const button = 1;');
  fs.writeFileSync(path.join(worktree, 'README.md'), '# hi');
  fs.writeFileSync(path.join(worktree, 'node_modules', 'pkg', 'index.js'), 'noise');
  fs.writeFileSync(path.join(worktree, 'build', 'output.js'), 'noise');
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'secret');
  // Ignore files apply without a git repository, deeper files override
  // shallower ones, and `.ignore` is honoured alongside `.gitignore`.
  fs.writeFileSync(path.join(worktree, '.gitignore'), 'generated/\n*.log\n!keep.log\nreinclude/\n.env\nzz*\nodd*/\nCaseRule.md\n');
  fs.writeFileSync(path.join(worktree, '.ignore'), 'secret-notes.md\n*.bak\n!reinclude/\n!zzdir/\n!/odd\\[x\\]/\n');
  // A directory re-included by a higher tier lists its contents.
  fs.mkdirSync(path.join(worktree, 'reinclude'));
  fs.writeFileSync(path.join(worktree, 'reinclude', 'kept.txt'), 'shown');
  // Other rules from the overruled file still apply beneath it.
  fs.writeFileSync(path.join(worktree, 'reinclude', 'debug.log'), 'hidden');
  fs.writeFileSync(path.join(worktree, 'reinclude', '.env'), 'hidden');
  fs.mkdirSync(path.join(worktree, 'zzdir'));
  fs.writeFileSync(path.join(worktree, 'zzdir', 'zzfile.txt'), 'hidden');
  fs.writeFileSync(path.join(worktree, 'zzdir', 'other.txt'), 'shown');
  // The directory negation is escaped, so glob characters match literally.
  fs.mkdirSync(path.join(worktree, 'odd[x]'));
  fs.writeFileSync(path.join(worktree, 'odd[x]', 'kept.txt'), 'shown');
  fs.writeFileSync(path.join(worktree, 'odd[x]', 'hidden.log'), 'hidden');
  // Ignore rules are case-sensitive, as git and ripgrep are on Linux. On Windows
  // the filesystem cannot hold both names, and git matches rules without case.
  fs.writeFileSync(path.join(worktree, 'CaseRule.md'), 'hidden');
  if (process.platform !== 'win32') fs.writeFileSync(path.join(worktree, 'caserule.md'), 'shown');
  fs.mkdirSync(path.join(worktree, 'generated'));
  fs.writeFileSync(path.join(worktree, 'generated', 'out.js'), 'noise');
  fs.writeFileSync(path.join(worktree, 'debug.log'), 'noise');
  fs.writeFileSync(path.join(worktree, 'keep.log'), 'kept');
  fs.writeFileSync(path.join(worktree, 'secret-notes.md'), 'hidden');
  fs.mkdirSync(path.join(worktree, 'nested'));
  // A deeper `.gitignore` cannot re-include what `.ignore` excluded.
  fs.writeFileSync(path.join(worktree, 'nested', '.gitignore'), '*.tmp\n!debug.log\n!keep.bak\n');
  fs.writeFileSync(path.join(worktree, 'nested', 'keep.bak'), 'still ignored');
  fs.mkdirSync(path.join(worktree, 'src-long'));
  fs.writeFileSync(path.join(worktree, 'src-long', 'a.ts'), 'sibling');
  fs.writeFileSync(path.join(worktree, 'nested', 'x.tmp'), 'noise');
  fs.writeFileSync(path.join(worktree, 'nested', 'debug.log'), 'reincluded');
  fs.mkdirSync(path.join(worktree, 'lib'));
  fs.writeFileSync(path.join(worktree, 'lib', 'UserProfileCard.vue'), '<template />');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(worktree, 'README.md'), future, future);
  // File symlinks need Developer Mode on Windows, so those assertions skip when
  // creation is refused. Directory links use junctions, which need no privilege.
  const fileLink = trySymlink(path.join(outside, 'secret.ts'), path.join(worktree, 'src', 'link.ts'), 'file');
  fs.symlinkSync(outside, path.join(worktree, 'linked-dir'), 'junction');
  fs.symlinkSync(worktree, path.join(worktree, 'src', 'self-link'), 'junction');
  // A linked worktree reads `info/exclude` from its repository's common
  // directory, found through the `.git` file and `commondir`.
  const repository = path.join(directory, 'repository');
  const linked = path.join(directory, 'linked-worktree');
  fs.mkdirSync(path.join(repository, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(repository, '.git', 'worktrees', 'linked'), { recursive: true });
  fs.writeFileSync(path.join(repository, '.git', 'info', 'exclude'), 'excluded.txt\nreinclude/\n');
  fs.writeFileSync(path.join(repository, '.git', 'worktrees', 'linked', 'commondir'), '../..\n');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(repository, '.git', 'worktrees', 'linked')}\n`);
  fs.writeFileSync(path.join(linked, 'excluded.txt'), 'hidden');
  fs.writeFileSync(path.join(linked, 'included.txt'), 'shown');
  fs.writeFileSync(path.join(linked, '.gitignore'), '!reinclude/\n');
  fs.mkdirSync(path.join(linked, 'reinclude'));
  fs.writeFileSync(path.join(linked, 'reinclude', 'kept.txt'), 'shown');
  const imageUpload = path.join(uploads, 'upload-1.png');
  fs.writeFileSync(imageUpload, Buffer.from('89504e470d0a1a0a', 'hex'));
  const textUpload = path.join(uploads, 'notes.md');
  fs.writeFileSync(textUpload, '# notes');
  const outsideUpload = path.join(outside, 'not-upload.png');
  fs.writeFileSync(outsideUpload, 'x');

  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const now = new Date().toISOString();
    database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project_test', 'Test', directory, now, now);
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,created_at,updated_at) values ('process_test','project_test','agent','Test','running',?,?,?)`).run(worktree, now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor) values ('session_test','project_test','process_test','codex','integrated',?,'orchestrator','found','user')`).run(now);

    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,cwd,created_at,updated_at) values ('process_linked','project_test','agent','Linked','running',?,?,?)`).run(linked, now, now);
    database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,interface_mode,started_at,session_role,resume_status,created_by_actor) values ('session_linked','project_test','process_linked','codex','integrated',?,'orchestrator','found','user')`).run(now);

    const files = new WorktreeFileService(database, new UploadService(uploads));
    assert.deepEqual((await files.search('process_linked', '')).map((file) => file.path).sort(), ['.gitignore', 'included.txt', 'reinclude/kept.txt'], 'the common repository exclude applies to a linked worktree');
    const results = await files.search('process_test', 'app');
    assert.deepEqual(results.map((file) => file.path), ['src/app.ts']);
    assert.equal(results[0]?.name, 'app.ts');
    assert.deepEqual((await files.search('process_test', 'button')).map((file) => file.path), ['src/components/button.ts']);
    const all = await files.search('process_test', '');
    assert.ok(all.length >= 3, 'an empty query lists the bounded worktree');
    assert.ok(all.every((file) => !file.path.startsWith('node_modules') && !file.path.startsWith('build')), 'heavy directories are skipped');
    assert.ok(all.every((file) => !file.path.includes('link')), 'symlinks are skipped');
    const listed = new Set(all.map((file) => file.path));
    for (const ignored of ['generated/out.js', 'debug.log', 'secret-notes.md', 'nested/x.tmp', 'nested/keep.bak', 'reinclude/debug.log', 'reinclude/.env', 'zzdir/zzfile.txt', 'odd[x]/hidden.log', 'CaseRule.md']) {
      assert.ok(!listed.has(ignored), `${ignored} is ignored`);
    }
    for (const kept of ['keep.log', 'nested/debug.log', 'lib/UserProfileCard.vue', 'reinclude/kept.txt', 'zzdir/other.txt', 'odd[x]/kept.txt', ...(process.platform === 'win32' ? [] : ['caserule.md'])]) {
      assert.ok(listed.has(kept), `${kept} is listed`);
    }
    assert.equal(all[0]?.path, 'README.md', 'an empty query lists the most recently modified files first');
    const fuzzy = await files.search('process_test', 'upc');
    assert.equal(fuzzy[0]?.path, 'lib/UserProfileCard.vue', 'camelCase initials match');
    assert.deepEqual(fuzzy[0]?.matches, [4, 8, 15], 'matched characters are reported for highlighting');
    assert.equal((await files.search('process_test', 'btn'))[0]?.path, 'src/components/button.ts', 'subsequences match');
    assert.deepEqual((await files.search('process_test', 'comp btn')).map((file) => file.path), ['src/components/button.ts'], 'every term must match');
    assert.deepEqual(await files.search('process_test', 'zzz'), []);
    assert.ok(all.every((file) => !file.path.endsWith('/')), 'an empty query lists only files');
    assert.deepEqual((await files.search('process_test', 'components'))[0], { path: 'src/components/', name: 'components/', matches: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13] }, 'directories are listed with a trailing slash');
    assert.deepEqual((await files.search('process_test', 'src/components/')).map((file) => file.path), ['src/components/button.ts'], 'a directory query lists its contents, not itself');
    assert.deepEqual((await files.search('process_test', 'src/')).map((file) => file.path), ['src/components/', 'src/app.ts'], 'a directory query lists direct children, directories first, and no siblings');
    const scoped = await files.search('process_test', 'src/btn');
    assert.deepEqual(scoped.map((file) => file.path), ['src/components/button.ts'], 'text after a directory matches inside it');
    assert.deepEqual(scoped[0]?.matches, [15, 17, 20]);
    assert.equal((await files.search('process_test', '', 2)).length, 2, 'results are bounded');
    await assert.rejects(files.search('missing_process', ''), /not found/);

    const resolved = await files.resolve('process_test', {
      text: 'x',
      references: [{ path: 'src/app.ts' }],
      attachments: []
    });
    assert.equal(resolved.references[0]?.path, fs.realpathSync(path.join(worktree, 'src', 'app.ts')));
    assert.equal(resolved.references[0]?.relativePath, 'src/app.ts');
    assert.equal(resolved.references[0]?.name, 'app.ts');
    const directoryReference = await files.resolve('process_test', { text: 'x', references: [{ path: 'src/components/' }] });
    assert.deepEqual(directoryReference.references[0], { path: fs.realpathSync(path.join(worktree, 'src', 'components')), name: 'components/', relativePath: 'src/components/', directory: true });
    if (process.platform === 'win32') {
      // Windows paths resolve, but agents and the UI always see `/` separators.
      const native = await files.resolve('process_test', { text: 'x', references: [{ path: 'src\\components\\button.ts' }, { path: path.join(worktree, 'src', 'app.ts') }, { path: 'src\\components\\' }] });
      assert.deepEqual(native.references.map((reference) => reference.relativePath), ['src/components/button.ts', 'src/app.ts', 'src/components/']);
      assert.equal(native.references[2]?.directory, true);
      assert.equal((await files.search('process_test', 'src\\components\\')).every((file) => file.path.startsWith('src/components/')), true, 'a typed backslash scopes like a slash');
    }
    await assert.rejects(files.resolve('process_test', { text: 'x', references: [{ path: 'src/components' }] }), /must end with \//);
    await assert.rejects(files.resolve('process_test', { text: 'x', references: [{ path: 'src/app.ts/' }] }), /not a directory|not found/);
    for (const root of ['./', 'src/../', 'src/self-link/']) {
      await assert.rejects(files.resolve('process_test', { text: 'x', references: [{ path: root }] }), /working directory itself/, `${root} is not a reference to the filesystem root`);
    }
    const messageId = '44444444-4444-4444-4444-444444444444';
    assert.equal((await files.resolve('process_test', { text: 'x', messageId })).messageId, messageId);
    assert.equal((await files.resolve('process_test', { text: 'x', messageId: 'not-a-uuid' })).messageId, undefined);
    for (const reference of ['../outside/secret.ts', path.join(outside, 'secret.ts'), '/etc/passwd', ...(fileLink ? ['src/link.ts'] : []), 'linked-dir/secret.ts', 'linked-dir/']) {
      await assert.rejects(
        files.resolve('process_test', { text: 'x', references: [{ path: reference }], attachments: [] }),
        /outside the agent working directory/,
        `${reference} must not escape the worktree`
      );
    }
    await assert.rejects(files.resolve('process_test', { text: 'x', references: [{ path: 'src/missing.ts' }], attachments: [] }), /not found/);

    const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const attached = await files.resolve('process_test', { text: 'x', attachments: [{ path: imageUpload, name: 'pixel.png', mime: 'image/png' }] });
    // The rendered MIME comes from the bytes, and uploads carry the exact
    // validated base64 for inline provider transports.
    assert.deepEqual(attached.attachments[0], { path: imageUpload, name: 'pixel.png', mime: 'image/png', size: 8, data: imageBytes.toString('base64') });
    const spoofed = await files.resolve('process_test', { text: 'x', attachments: [{ path: imageUpload, name: 'pixel.png', mime: 'text/html' }] });
    assert.equal(spoofed.attachments[0]?.mime, 'image/png', 'supplied MIME is ignored');
    const textAttached = await files.resolve('process_test', { text: 'x', attachments: [{ path: textUpload, name: 'notes.md', mime: 'application/zip' }] });
    assert.equal(textAttached.attachments[0]?.mime, 'text/plain', 'content decides text attachments');
    assert.equal(textAttached.attachments[0]?.data, Buffer.from('# notes').toString('base64'));
    await assert.rejects(files.resolve('process_test', { text: 'x', attachments: [{ path: outsideUpload, name: 'x.png', mime: 'image/png' }] }), /not a managed upload/);
    const zipUpload = path.join(uploads, 'archive.zip');
    fs.writeFileSync(zipUpload, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    await assert.rejects(files.resolve('process_test', { text: 'x', attachments: [{ path: zipUpload, name: 'archive.zip', mime: 'image/png' }] }), /not text or a supported image/);
    fs.mkdirSync(path.join(directory, 'uploads-other'), { recursive: true });
    const siblingUpload = path.join(directory, 'uploads-other', 'sibling.png');
    fs.writeFileSync(siblingUpload, imageBytes);
    await assert.rejects(files.resolve('process_test', { text: 'x', attachments: [{ path: siblingUpload, name: 'sibling.png', mime: 'image/png' }] }), /not a managed upload/, 'sibling-prefix paths stay outside the store');
    // A `.png` that actually holds SVG or ZIP content must never become an image.
    const disguisedSvg = path.join(uploads, 'disguised.png');
    fs.writeFileSync(disguisedSvg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const svgResolved = await files.resolve('process_test', { text: 'x', attachments: [{ path: disguisedSvg, name: 'disguised.png', mime: 'image/png' }] });
    assert.equal(svgResolved.attachments[0]?.mime, 'text/plain');
    assert.equal(svgResolved.attachments[0]?.data, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'));
    const disguisedZip = path.join(uploads, 'disguised-zip.png');
    fs.writeFileSync(disguisedZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    await assert.rejects(files.resolve('process_test', { text: 'x', attachments: [{ path: disguisedZip, name: 'disguised-zip.png', mime: 'image/png' }] }), /not text or a supported image/);
    fs.writeFileSync(path.join(outside, 'upload-link.png'), 'x');
    if (trySymlink(path.join(outside, 'upload-link.png'), path.join(uploads, 'escape.png'), 'file')) {
      await assert.rejects(files.resolve('process_test', { text: 'x', attachments: [{ path: path.join(uploads, 'escape.png'), name: 'escape.png', mime: 'image/png' }] }), /not a managed upload/, 'symlinked uploads resolve outside the store');
    }

    // Full-content text validation: a NUL after the old sample window is
    // binary, a valid UTF-8 sequence split at that boundary is text, and a
    // PDF is accepted by content even without an extension.
    const lateNul = path.join(uploads, 'late-nul.md');
    fs.writeFileSync(lateNul, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0]), Buffer.from('tail')]));
    await assert.rejects(files.resolve('process_test', { text: 'x', attachments: [{ path: lateNul, name: 'late-nul.md', mime: 'text/markdown' }] }), /not text or a supported image/);
    const splitUtf8 = path.join(uploads, 'split-utf8.txt');
    fs.writeFileSync(splitUtf8, Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from('é', 'utf8'), Buffer.from(' end')]));
    const split = await files.resolve('process_test', { text: 'x', attachments: [{ path: splitUtf8, name: 'split-utf8.txt', mime: 'text/plain' }] });
    assert.equal(split.attachments[0]?.mime, 'text/plain', 'a UTF-8 sequence across the sample boundary stays text');
    const extensionlessPdf = path.join(uploads, 'extensionless');
    fs.writeFileSync(extensionlessPdf, '%PDF-1.7\ncontent');
    const pdf = await files.resolve('process_test', { text: 'x', attachments: [{ path: extensionlessPdf, name: 'file', mime: 'application/octet-stream' }] });
    assert.equal(pdf.attachments[0]?.mime, 'application/pdf', 'content decides a supported PDF');

    const seen: ResolvedIntegratedPrompt[] = [];
    const provider: IntegratedProviderService = {
      prepare: async () => ({ resumeId: 'thread_test', argv: [] }),
      conversation: async () => ({ status: 'working' }),
      prompt: async (_processId, input) => { seen.push(input); return { turnId: 'turn_test' }; },
      interrupt: async () => {},
      replyPermission: async () => {},
      replyQuestion: async () => {}
    };
    const integrated = new IntegratedAgentService(database, { codex: provider }, undefined, files);
    await integrated.prompt('process_test', { text: 'hello @src/app.ts', references: [{ path: 'src/app.ts' }], messageId });
    assert.equal(seen[0]?.references[0]?.relativePath, 'src/app.ts');
    assert.equal(seen[0]?.messageId, messageId);
    await assert.rejects(integrated.prompt('process_test', { text: 'x', references: [{ path: '../escape.ts' }] }), /outside the agent working directory/);
    const search = await integrated.files('process_test', 'app');
    assert.deepEqual(search.map((file) => file.path), ['src/app.ts']);

    const textOnly = new IntegratedAgentService(database, { codex: provider });
    await textOnly.prompt('process_test', 'plain text still works');
    await assert.rejects(textOnly.prompt('process_test', { text: 'x', references: [{ path: 'src/app.ts' }] }), /unavailable/);
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void main().then(() => console.log('integrated files smoke ok'));
