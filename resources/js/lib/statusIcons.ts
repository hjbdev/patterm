import type { Component } from 'vue';
import {
  Bot,
  Circle,
  CircleCheck,
  CirclePause,
  CircleSlash,
  CircleX,
  Cog,
  User
} from 'lucide-vue-next';
import type { ActivityState, ActorType, ProcessRecord, SessionRecord } from '../types';

// A resolved icon for a domain state: which Lucide glyph, its colour, whether it
// spins (working/thinking), and a human label used for the title / aria-label.
export interface IconSpec {
  icon?: Component;
  glyph?: string;
  class: string;
  spin: boolean;
  label: string;
  spinner?: boolean;
  ring?: boolean;
  // When true, render a small centred status dot instead of the glyph.
  dot?: boolean;
}

// Activity of a live agent/process. Mirrors patterm-cli IdleState
// (internal/app idle detection). The spinner is reserved for actively-working
// states; an idle-but-alive entity is a solid circle.
export function activityIcon(state: ActivityState): IconSpec {
  switch (state) {
    case 'working':
      return { spinner: true, class: 'text-success', spin: false, label: 'Working' };
    case 'thinking':
      return { spinner: true, class: 'text-success', spin: false, label: 'Thinking' };
    case 'permission':
      return { glyph: '?', class: 'text-warning', spin: false, label: 'Needs permission' };
    case 'error':
      return { glyph: '✕', class: 'text-destructive', spin: false, label: 'Error' };
    case 'idle':
      return { ring: true, class: 'text-muted-foreground', spin: false, label: 'Idle' };
    case 'unknown':
    default:
      return { ring: true, class: 'text-muted-foreground', spin: false, label: 'Unknown' };
  }
}

export function sessionStatusIcon(session: SessionRecord): IconSpec {
  if (session.exitedAt) {
    if (session.resumeStatus === 'missing') {
      return { icon: CircleSlash, class: 'text-muted-foreground', spin: false, label: 'Exited · no resume' };
    }
    return { icon: CircleCheck, class: 'text-muted-foreground', spin: false, label: 'Exited' };
  }
  return activityIcon(session.activity);
}

export function processStatusIcon(proc: ProcessRecord): IconSpec {
  switch (proc.status) {
    case 'running':
      return activityIcon(proc.activity);
    case 'stopped':
      return { icon: CirclePause, class: 'text-muted-foreground', spin: false, label: 'Stopped' };
    case 'failed':
      return { icon: CircleX, class: 'text-destructive', spin: false, label: 'Failed' };
    case 'exited':
    default:
      return { icon: CircleCheck, class: 'text-muted-foreground', spin: false, label: 'Exited' };
  }
}

export function actorIcon(actor: ActorType): IconSpec {
  switch (actor) {
    case 'human':
      return { icon: User, class: 'text-muted-foreground', spin: false, label: 'Human' };
    case 'system':
      return { icon: Cog, class: 'text-muted-foreground', spin: false, label: 'System' };
    case 'agent':
    default:
      return { icon: Bot, class: 'text-muted-foreground', spin: false, label: 'Agent' };
  }
}
