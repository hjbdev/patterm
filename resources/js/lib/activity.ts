
// Whether an agent is blocked on the user: an approval (`permission`) or an
// answer (`question`).
export function awaitingUser(activity: unknown): activity is 'permission' | 'question' {
  return activity === 'permission' || activity === 'question';
}

// What a waiting agent is waiting for, lower case, such as "has a question".
export function waitingReason(activity: 'permission' | 'question'): string {
  return activity === 'question' ? 'has a question' : 'needs permission';
}
