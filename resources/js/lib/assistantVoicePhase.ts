// What the assistant's voice session is doing, as the orb and its label show it.
export type VoicePhase = 'connecting' | 'listening' | 'speaking' | 'working' | 'muted' | 'ended' | 'failed';

export const VOICE_PHASE_LABELS: Record<VoicePhase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening',
  speaking: 'Speaking',
  working: 'Working',
  muted: 'Muted',
  ended: 'Voice ended',
  failed: 'Voice stopped'
};

// One-line hints under the label, so each state says what it means for you.
export const VOICE_PHASE_HINTS: Record<VoicePhase, string> = {
  connecting: 'Setting up the call',
  listening: 'Go ahead, I’m listening',
  speaking: 'Interrupt any time',
  working: 'Codex is on it',
  muted: 'Your microphone is off',
  ended: 'Start voice again from the header',
  failed: ''
};
