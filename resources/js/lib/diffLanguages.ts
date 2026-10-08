import { EXTENSION_TO_FILE_FORMAT, getCustomExtensionsVersion, replaceCustomExtensions } from '@pierre/diffs';
import { bundledLanguages } from './shiki';

// Pierre picks a grammar from the file name and fails to highlight when Shiki
// lacks it. Files in languages Patterm doesn't bundle diff as plain text.
const plainText = Object.fromEntries(
  Object.entries(EXTENSION_TO_FILE_FORMAT)
    .filter(([, lang]) => lang != null && lang !== 'text' && !Object.hasOwn(bundledLanguages, lang))
    .map(([extension]) => [extension, 'text'])
);
replaceCustomExtensions(getCustomExtensionsVersion() + 1, plainText);
