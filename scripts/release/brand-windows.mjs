import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

// ProductName is also used by Electron's Windows toast shortcut registration.
export function brandWindowsExecutable(contents, icon, version) {
  const executable = NtExecutable.from(contents);
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) throw new Error('Expected one Windows executable version resource');
  const info = versions[0];
  const numeric = version.split('-')[0];
  info.setFileVersion(numeric);
  info.setProductVersion(numeric);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setStringValues(language, {
      ProductName: 'Patterm', FileDescription: 'Patterm', InternalName: 'Patterm',
      OriginalFilename: 'Patterm.exe', FileVersion: version, ProductVersion: version
    });
  }
  info.outputToResourceEntries(resources.entries);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (groups.length !== 1) throw new Error('Expected one Windows executable icon group');
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, groups[0].id, groups[0].lang,
    Data.IconFile.from(icon).icons.map((entry) => entry.data));
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}
