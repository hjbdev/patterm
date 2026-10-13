// Environment variable names are case-insensitive on Windows (`Path`, `PATH`),
// but a copied object is not. Read and write through these helpers whenever an
// environment object is copied or merged.

const windows = (): boolean => process.platform === 'win32';

export function envKey(env: NodeJS.ProcessEnv, name: string): string {
  if (!windows()) return name;
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper) ?? name;
}

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[envKey(env, name)];
}

// Returns a copy of `env` with `overrides` applied, replacing any differently
// cased variants on Windows. Undefined overrides remove the variable.
export function withEnv(env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(overrides)) {
    if (windows()) {
      const upper = name.toUpperCase();
      for (const key of Object.keys(next)) if (key.toUpperCase() === upper) delete next[key];
    }
    if (value === undefined) delete next[name];
    else next[name] = value;
  }
  return next;
}

// A view of `env` whose property access ignores case on Windows, so existing
// `env.PATH` reads keep working on an object holding `Path`.
export function caseInsensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!windows()) return env;
  const target: NodeJS.ProcessEnv = { ...env };
  return new Proxy(target, {
    get: (object, name) => (typeof name === 'string' ? object[envKey(object, name)] : undefined),
    has: (object, name) => typeof name === 'string' && envKey(object, name) in object,
    set: (object, name, value) => {
      if (typeof name !== 'string') return false;
      object[envKey(object, name)] = value;
      return true;
    },
    deleteProperty: (object, name) => {
      if (typeof name === 'string') delete object[envKey(object, name)];
      return true;
    },
    getOwnPropertyDescriptor: (object, name) =>
      typeof name === 'string' ? Object.getOwnPropertyDescriptor(object, envKey(object, name)) : undefined
  });
}
