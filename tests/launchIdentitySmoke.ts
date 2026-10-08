import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveLaunchIdentity } from '../desktop/main/launchIdentity';

function main(): void {
  const appDataRoot = path.join(path.sep, 'home', 'alex', '.config');

  assert.deepEqual(
    resolveLaunchIdentity({
      appDataRoot,
      env: {},
      isInstalledLaunch: false,
      isPackaged: false
    }),
    {
      appName: 'patterm-desktop-dev',
      appDataPath: path.join(appDataRoot, 'patterm-desktop-dev'),
      mode: 'development',
      explicitAppData: false
    }
  );

  assert.deepEqual(
    resolveLaunchIdentity({
      appDataRoot,
      env: { PATTERM_DESKTOP_RESOURCES: '/opt/patterm/resources' },
      isInstalledLaunch: true,
      isPackaged: false
    }),
    {
      appName: 'patterm-desktop',
      appDataPath: path.join(appDataRoot, 'patterm-desktop'),
      mode: 'production',
      explicitAppData: false
    }
  );

  assert.deepEqual(
    resolveLaunchIdentity({
      appDataRoot,
      env: {},
      isInstalledLaunch: false,
      isPackaged: true
    }),
    {
      appName: 'patterm-desktop',
      appDataPath: path.join(appDataRoot, 'patterm-desktop'),
      mode: 'production',
      explicitAppData: false
    }
  );

  assert.deepEqual(
    resolveLaunchIdentity({
      appDataRoot,
      env: { PATTERM_APP_DATA_PATH: 'tmp/custom-patterm-data' },
      isInstalledLaunch: false,
      isPackaged: false
    }),
    {
      appName: 'patterm-desktop-dev',
      appDataPath: path.resolve('tmp/custom-patterm-data'),
      mode: 'development',
      explicitAppData: true
    }
  );

  // eslint-disable-next-line no-console
  console.log('launch identity smoke ok');
}

main();
