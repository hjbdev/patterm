import { z } from 'zod';
import type { HarnessId, HarnessProvider, HarnessSignIn } from '../Harness/HarnessProvider';
import type { DatabaseService } from '../Services/DatabaseService';
import type { HarnessSignInService } from '../Services/HarnessSignInService';
import type { SettingsService } from '../Services/SettingsService';
import { USER_PROJECT_KINDS_SQL } from '../Services/PersonalProject';

export const onboardingStatusInput = z.object({ refresh: z.boolean().default(false) }).strict();
export const onboardingUpdateInput = z.object({ dismissed: z.boolean() }).strict();

export interface OnboardingHarness {
  harness: HarnessId;
  name: string;
  installed: boolean;
  version: string | null;
  // Null when not installed or the harness has no check.
  signIn: HarnessSignIn | null;
  signInOptional: boolean;
  signInCommand: string | null;
  installUrl: string | null;
}

export interface OnboardingSteps {
  install: boolean;
  signIn: boolean;
  project: boolean;
  start: boolean;
}

export interface OnboardingStatus {
  show: boolean;
  // Hidden by the owner, who can bring it back.
  dismissed: boolean;
  // True once every step has been done, now or before.
  completed: boolean;
  steps: OnboardingSteps;
  harnesses: OnboardingHarness[];
}

interface InstallationRow {
  harness: string;
  executable_path: string;
  version: string | null;
  status: string;
}

export interface OnboardingDeps {
  database: DatabaseService;
  settings: Pick<SettingsService, 'onboardingSettings' | 'saveOnboardingSettings'>;
  providers: HarnessProvider[];
  signIn: Pick<HarnessSignInService, 'check'>;
  // Re-scans PATH for harness CLIs.
  discover: () => Promise<unknown>;
}

// Works out the Get started checklist from what is already true: an agent
// installed and signed in, a project folder added, an agent started. Once it
// has been hidden or finished, it reads nothing and runs no checks.
export class GetOnboardingStatusAction {
  constructor(private readonly deps: OnboardingDeps) {}

  async execute(input: unknown = {}): Promise<OnboardingStatus> {
    const { refresh } = onboardingStatusInput.parse(input ?? {});
    const saved = this.deps.settings.onboardingSettings();
    if (saved.dismissed || saved.completed) {
      return { show: false, dismissed: saved.dismissed, completed: saved.completed, steps: { install: true, signIn: true, project: true, start: true }, harnesses: [] };
    }

    if (refresh) await this.deps.discover();
    const harnesses = await this.harnesses();
    const installed = harnesses.filter((harness) => harness.installed);
    const steps: OnboardingSteps = {
      install: installed.length > 0,
      // An agent without a check counts as signed in.
      signIn: installed.some((harness) => harness.signIn === 'signed_in' || harness.signIn === null || harness.signInOptional),
      project: this.hasProjectFolder(),
      start: this.hasStartedAgent()
    };
    const completed = Object.values(steps).every(Boolean);
    if (completed) this.deps.settings.saveOnboardingSettings({ ...saved, completed: true });
    return { show: !completed, dismissed: false, completed, steps, harnesses };
  }

  private async harnesses(): Promise<OnboardingHarness[]> {
    const rows = this.deps.database.connection
      .prepare('select harness, executable_path, version, status from harness_installations')
      .all() as unknown as InstallationRow[];
    return Promise.all(this.deps.providers.map(async (provider): Promise<OnboardingHarness> => {
      const row = rows.find((candidate) => candidate.harness === provider.id);
      const installed = row?.status === 'available' && Boolean(row.executable_path);
      return {
        harness: provider.id,
        name: provider.displayName,
        installed,
        version: installed ? row?.version ?? null : null,
        signIn: installed && row ? await this.deps.signIn.check(provider.id, row.executable_path) : null,
        signInOptional: provider.signInCheck?.optional === true,
        signInCommand: provider.signInCommand ?? null,
        installUrl: provider.installUrl ?? null
      };
    }));
  }

  // A repository folder: the built-in Personal project doesn't count.
  private hasProjectFolder(): boolean {
    return Boolean(this.deps.database.connection.prepare(`select 1 from projects where kind = 'workspace' limit 1`).get());
  }

  // An agent the owner started, not a bot, the assistant or a routine.
  private hasStartedAgent(): boolean {
    return Boolean(this.deps.database.connection.prepare(
      `select 1 from sessions
       join projects on projects.id = sessions.project_id
       where projects.kind in ${USER_PROJECT_KINDS_SQL}
         and sessions.session_role not in ('assistant', 'bot', 'routine')
         and sessions.bot_id is null
       limit 1`
    ).get());
  }
}

export class UpdateOnboardingAction {
  constructor(private readonly settings: Pick<SettingsService, 'onboardingSettings' | 'saveOnboardingSettings'>) {}

  execute(input: unknown): { dismissed: boolean } {
    const { dismissed } = onboardingUpdateInput.parse(input);
    const saved = this.settings.saveOnboardingSettings({ ...this.settings.onboardingSettings(), dismissed });
    return { dismissed: saved.dismissed };
  }
}
