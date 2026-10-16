import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { brandWindowsExecutable } from '../scripts/release/brand-windows.mjs';

test('Windows branding replaces Electron product metadata while preserving other resources', () => {
  const executable = NtExecutable.createEmpty(false, false);
  const resources = NtExecutableResource.from(executable);
  const language = { lang: 1033, codepage: 1200 };
  Resource.VersionInfo.create(1033, {}, [{ ...language, values: {
    ProductName: 'Electron', FileDescription: 'Electron', LegalCopyright: 'Keep upstream attribution'
  } }]).outputToResourceEntries(resources.entries);
  const icon = fs.readFileSync('public/icons/icon.ico');
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033,
    Data.IconFile.from(icon).icons.map((entry) => entry.data));
  resources.entries.push({ type: 24, id: 1, lang: 1033, codepage: 1200,
    bin: new TextEncoder().encode('<assembly>preserve manifest</assembly>').buffer });
  resources.outputResource(executable);
  const branded = NtExecutableResource.from(NtExecutable.from(
    brandWindowsExecutable(Buffer.from(executable.generate()), icon, '0.2.9-ci.42')));
  const info = Resource.VersionInfo.fromEntries(branded.entries)[0];
  const values = info.getStringValues(language);
  assert.equal(values.ProductName, 'Patterm');
  assert.equal(values.FileDescription, 'Patterm');
  assert.equal(values.OriginalFilename, 'Patterm.exe');
  assert.equal(values.ProductVersion, '0.2.9-ci.42');
  assert.equal(info.fixedInfo.productVersionLS, 9 << 16);
  assert.equal(values.LegalCopyright, 'Keep upstream attribution');
  assert.equal(Buffer.from(branded.entries.find((entry) => entry.type === 24).bin).toString(),
    '<assembly>preserve manifest</assembly>');
});
