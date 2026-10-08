import path from 'node:path';

export type LaunchMode = 'development' | 'production';

export interface LaunchIdentityInput {
  appDataRoot: string;
  env: NodeJS.ProcessEnv;
  isInstalledLaunch: boolean;
  isPackaged: boolean;
}

export interface LaunchIdentity {
  appName: string;
  appDataPath: string;
  mode: LaunchMode;
  explicitAppData: boolean;
}

const PRODUCTION_APP_NAME = 'patterm-desktop';
const DEVELOPMENT_APP_NAME = 'patterm-desktop-dev';

export function resolveLaunchIdentity(input: LaunchIdentityInput): LaunchIdentity {
  const mode: LaunchMode = input.isPackaged || input.isInstalledLaunch ? 'production' : 'development';
  const appName = mode === 'production' ? PRODUCTION_APP_NAME : DEVELOPMENT_APP_NAME;
  const explicitAppData = input.env.PATTERM_APP_DATA_PATH?.trim();

  return {
    appName,
    appDataPath: explicitAppData ? path.resolve(explicitAppData) : path.join(input.appDataRoot, appName),
    mode,
    explicitAppData: Boolean(explicitAppData)
  };
}
