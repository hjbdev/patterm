import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CreateProjectAction } from '../app/Actions/CreateProjectAction';
import { DRIVES_PATH, ListDirectoriesAction, listDirectoriesInput } from '../app/Actions/ListDirectoriesAction';
import { DatabaseService } from '../app/Services/DatabaseService';
import { ensurePersonalProject, PERSONAL_PROJECT_ID } from '../app/Services/PersonalProject';
import type { GitService } from '../app/Services/GitService';
import { ProjectLinkService } from '../app/Services/ProjectLinkService';
import { SettingsService } from '../app/Services/SettingsService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { TerminalService } from '../app/Services/TerminalService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { trySymlink } from './fixtures/SymlinkFixture';

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-project-'));
  let database: DatabaseService | undefined;
  try {
    database = new DatabaseService(tempDir);
    database.initialize();
    const timeline = new TimelineService(database);
    const action = new CreateProjectAction(database, timeline);

    const repoDir = path.join(tempDir, 'My Repo');
    fs.mkdirSync(repoDir);

    // Name defaults to the directory basename when omitted.
    const created = action.execute({ path: repoDir, name: '', actor_type: 'user', actor_id: null });
    assert.equal(created.existed, false);
    assert.equal(created.name, 'My Repo', 'name derived from basename');
    assert.equal(created.path, repoDir);

    const similarlyNamedDir = path.join(tempDir, 'My Replica');
    fs.mkdirSync(similarlyNamedDir);
    const similarlyNamed = action.execute({ path: similarlyNamedDir, name: 'My Replica', actor_type: 'user', actor_id: null });

    // Re-registering the same path is idempotent.
    const again = action.execute({ path: repoDir, name: 'Renamed', actor_type: 'user', actor_id: null });
    assert.equal(again.existed, true);
    assert.equal(again.project_id, created.project_id, 'same path returns the same project');

    // Windows names one directory several ways: drive and folder case, and `/`
    // for `\`. They all register the same project.
    if (process.platform === 'win32') {
      for (const spelling of [repoDir.toLowerCase(), repoDir.toUpperCase(), repoDir.replace(/\\/g, '/'), `${repoDir}\\`]) {
        const variant = action.execute({ path: spelling, name: '', actor_type: 'user', actor_id: null });
        assert.equal(variant.project_id, created.project_id, `${spelling} is the same project`);
        assert.equal(variant.existed, true);
      }
      assert.match(created.path, /^[A-Z]:\\/, 'a new project stores the drive letter in upper case');
    }

    // The snapshot surfaces registered projects as sidebar groups.
    const repo = new WorkbenchRepository(database);
    assert.equal(repo.snapshot().projects[0]?.project.id, created.project_id, 'created project is listed in the snapshot');

    // Invalid paths are rejected.
    assert.throws(() => action.execute({ path: path.join(tempDir, 'nope'), name: '', actor_type: 'user', actor_id: null }), /does not exist/);
    const filePath = path.join(tempDir, 'a-file');
    fs.writeFileSync(filePath, 'x');
    assert.throws(() => action.execute({ path: filePath, name: '', actor_type: 'user', actor_id: null }), /not a directory/);

    // The registry exposes project creation through project_create.
    const fakeTerminal = { isAvailable: () => false } as unknown as TerminalService;
    const registry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: fakeTerminal,
      timeline,
      workbench: repo
    });

    const otherDir = path.join(tempDir, 'other');
    fs.mkdirSync(otherDir);
    const viaRegistry = (await registry.call('project_create', { path: otherDir })) as { project_id: string; name: string };
    assert.equal(viaRegistry.name, 'other', 'registry create derives the name');
    assert.ok(viaRegistry.project_id.startsWith('project_'));
    assert.deepEqual(
      repo.snapshot().projects.map((project) => project.project.id),
      [created.project_id, similarlyNamed.project_id, viaRegistry.project_id],
      'snapshot keeps multiple project groups'
    );

    // Logo candidates come from favicon, icon, and logo files in the project.
    fs.mkdirSync(path.join(repoDir, 'public', 'icons'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    fs.writeFileSync(path.join(repoDir, 'public', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    fs.writeFileSync(path.join(repoDir, 'public', 'icons', 'icon-512.png'), png);
    fs.writeFileSync(path.join(repoDir, 'public', 'favicon.ico'), '');
    fs.writeFileSync(path.join(repoDir, 'public', 'icons', 'icon_headshot.svg'), '<svg></svg>');
    fs.writeFileSync(path.join(repoDir, 'node_modules', 'pkg', 'logo.svg'), '<svg></svg>');
    const { candidates } = (await registry.call('project_logo_candidates', { project_id: created.project_id })) as { candidates: Array<{ path: string; data_url: string }> };
    assert.deepEqual(candidates.map((candidate) => candidate.path), [path.join('public', 'icons', 'icon-512.png'), path.join('public', 'favicon.svg')], 'icons before favicons; empty files, glyphs, and dependencies skipped');
    assert.match(candidates[1]!.data_url, /^data:image\/svg\+xml;base64,/);

    // Logos are stored as small raster data URLs whose content matches their type.
    const logo = `data:image/png;base64,${png.toString('base64')}`;
    await registry.call('project_set_logo', { project_id: created.project_id, logo });
    assert.equal(repo.snapshot().projects[0]?.project.logo, logo, 'snapshot carries the logo');
    await assert.rejects(registry.call('project_set_logo', { project_id: created.project_id, logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPEG, or WebP/);
    await assert.rejects(registry.call('project_set_logo', { project_id: created.project_id, logo: 'data:image/jpeg;base64,' + png.toString('base64') }), /does not match/);
    await registry.call('project_set_logo', { project_id: created.project_id, logo: null });
    assert.equal(repo.getProject(created.project_id)?.logo, null, 'logo cleared');

    // The browser path picker lists subdirectories, marking repositories.
    const browseRoot = path.join(tempDir, 'browse');
    fs.mkdirSync(path.join(browseRoot, 'repo10', '.git'), { recursive: true });
    fs.mkdirSync(path.join(browseRoot, 'repo9'));
    fs.mkdirSync(path.join(browseRoot, '.hidden'));
    fs.writeFileSync(path.join(browseRoot, 'notes.txt'), 'x');
    // Windows refuses symlinks without Developer Mode; the link assertions skip then.
    const linked = trySymlink(path.join(browseRoot, 'repo9'), path.join(browseRoot, 'linked'), 'dir')
      && trySymlink(path.join(browseRoot, 'notes.txt'), path.join(browseRoot, 'linked-file'), 'file');
    const linkEntries = linked ? ['linked'] : [];
    const lister = new ListDirectoriesAction(browseRoot);
    const listing = lister.execute(listDirectoriesInput.parse({}));
    assert.equal(listing.path, browseRoot, 'an empty path lists home');
    assert.equal(listing.parent, tempDir);
    assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.git]), [...linkEntries.map((name) => [name, false]), ['repo9', false], ['repo10', true]], 'directories and directory links only, numeric order, hidden skipped');
    assert.deepEqual(lister.execute(listDirectoriesInput.parse({ path: '~', show_hidden: true })).entries.map((entry) => entry.name), ['.hidden', ...linkEntries, 'repo9', 'repo10'], '~ is home; hidden folders on request');
    assert.equal(lister.execute(listDirectoriesInput.parse({ path: '~/repo10' })).path, path.join(browseRoot, 'repo10'), '~/ expands');
    // A Windows drive root leads up to the list of drives.
    assert.equal(lister.execute(listDirectoriesInput.parse({ path: '/' })).parent, process.platform === 'win32' ? DRIVES_PATH : null, 'the root has no parent');
    assert.throws(() => lister.execute(listDirectoriesInput.parse({ path: path.join(browseRoot, 'notes.txt') })), /not a directory/);
    assert.throws(() => lister.execute(listDirectoriesInput.parse({ path: path.join(browseRoot, 'missing') })), /does not exist/);
    const bulkRoot = path.join(tempDir, 'bulk');
    for (let index = 0; index <= 500; index += 1) fs.mkdirSync(path.join(bulkRoot, `dir${String(index).padStart(3, '0')}`), { recursive: true });
    const capped = lister.execute(listDirectoriesInput.parse({ path: bulkRoot }));
    assert.equal(capped.entries.length, 500);
    assert.equal(capped.truncated, true, 'large folders are capped');
    const narrowed = lister.execute(listDirectoriesInput.parse({ path: bulkRoot, filter: 'DIR500' }));
    assert.deepEqual(narrowed.entries.map((entry) => entry.name), ['dir500'], 'the filter applies before the cap, ignoring case');
    assert.equal(narrowed.truncated, false);
    const viaTool = (await registry.call('fs_directories', { path: browseRoot })) as { entries: unknown[] };
    assert.equal(viaTool.entries.length, 2 + linkEntries.length,'the registry exposes patterm.fs.directories');

    // The Personal project lives in the data directory and is created once
    // however often startup ensures it. It is opt-in, so it starts hidden.
    ensurePersonalProject(database, tempDir);
    ensurePersonalProject(database, tempDir);
    const personalDir = path.join(tempDir, 'personal');
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') assert.equal(fs.statSync(personalDir).mode & 0o777, 0o700, 'the Personal directory is private');
    assert.ok(!repo.listProjects().some((project) => project.kind === 'personal'), 'Personal is hidden until turned on');
    assert.ok(!repo.snapshot().projects.some((project) => project.project.kind === 'personal'), 'nor in the snapshot');

    // Turned on, it is listed first.
    const settings = new SettingsService(database);
    settings.updateAppearanceSettings({ ...settings.appearanceSettings(), personalProject: true });
    assert.deepEqual(repo.listProjects()[0], { id: PERSONAL_PROJECT_ID, name: 'Personal', path: personalDir, logo: null, kind: 'personal' });
    assert.equal(repo.listProjects().filter((project) => project.kind === 'personal').length, 1, 'one Personal project');
    assert.equal(repo.snapshot().projects[0]?.project.id, PERSONAL_PROJECT_ID, 'first in the snapshot too');

    // It never links to another host's project, nor is it offered for linking.
    const projectLinks = new ProjectLinkService(database, { query: async () => { throw new Error('not a repository'); } } as unknown as GitService);
    assert.ok(!(await projectLinks.projects()).some((project) => project.id === PERSONAL_PROJECT_ID), 'Personal is not offered for linking');
    assert.throws(() => projectLinks.link('host_peer', PERSONAL_PROJECT_ID, { id: PERSONAL_PROJECT_ID, name: 'Personal' }), /does not exist/);

    // Turned off again, it is hidden without being removed.
    settings.updateAppearanceSettings({ ...settings.appearanceSettings(), personalProject: false });
    assert.ok(!repo.listProjects().some((project) => project.kind === 'personal'), 'a hidden Personal project is not listed');
    assert.ok(database.connection.prepare('select 1 from projects where id = ?').get(PERSONAL_PROJECT_ID), 'hiding keeps the project');

    database.dispose();
    // eslint-disable-next-line no-console
    console.log('project create smoke ok');
  } finally {
    // Windows cannot delete a directory holding an open database.
    try { database?.dispose(); } catch { /* already disposed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
