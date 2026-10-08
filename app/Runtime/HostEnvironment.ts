import fs from 'node:fs';

// Service-mode hosts start in their own systemd unit. The launcher passes the
// resolved shell environment through a private file instead of the command
// line, where other local users could read it. Load it once, then remove it.
const file = process.env.PATTERM_HOST_ENV_FILE;
if (file) {
  delete process.env.PATTERM_HOST_ENV_FILE;
  const env = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  fs.rmSync(file, { force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}
