import assert from 'node:assert/strict';

import type { AssistantFocus } from '../resources/js/lib/assistantFocus';
import { decideFollow, initialFollowState, routeChanged, showRequested, type FollowContext, type FollowState } from '../resources/js/lib/assistantFollow';

function focus(turnId: string, target: string, background = false): AssistantFocus {
  return { turnId, target: { key: target, projectId: 'project_a', label: target }, source: 'read', background };
}

const open: FollowContext = { enabled: true, visible: true, shown: false, busy: false };
const loaded = (baselineTurnId: string | null): FollowState => ({ ...initialFollowState(), baselineTurnId });

// A new turn about something else is shown once.
let state = loaded('turn_0');
let decision = decideFollow(state, focus('turn_1', 'login'), open);
assert.equal(decision.show, true);
state = decision.state;
assert.equal(decideFollow(state, focus('turn_1', 'login'), open).show, false);

// Nothing is followed until the transcript has loaded, since any turn may be old.
assert.equal(decideFollow(initialFollowState(), focus('turn_1', 'login'), open).show, false);

// The turn on screen at load is never followed, however late its focus resolves.
// A conversation that was empty at load has no such turn, so its first is followed.
assert.equal(decideFollow(loaded('turn_1'), focus('turn_1', 'login'), open).show, false);
assert.equal(decideFollow(loaded(null), focus('turn_1', 'login'), open).show, true);

// Off, out of view, and nothing to show do nothing.
assert.equal(decideFollow(state, focus('turn_2', 'docs'), { ...open, enabled: false }).show, false);
assert.equal(decideFollow(state, focus('turn_2', 'docs'), { ...open, visible: false }).show, false);
assert.equal(decideFollow(state, null, open).show, false);

// Already on screen: recorded, not navigated.
decision = decideFollow(state, focus('turn_2', 'docs'), { ...open, shown: true });
assert.equal(decision.show, false);
assert.equal(decision.state.applied, 'turn_2|docs');

// Busy: held back for the chip, and offered again by a later decision.
decision = decideFollow(state, focus('turn_2', 'docs'), { ...open, busy: true });
assert.equal(decision.show, false);
assert.equal(decideFollow(decision.state, focus('turn_2', 'docs'), open).show, true);

// Automatic redirects, such as a project opening its first agent, never pause.
const change = { enabled: true, manual: false, showsFocus: false, latestTurnId: 'turn_1', focus: focus('turn_1', 'login') };
assert.equal(routeChanged(state, change), state);
assert.equal(routeChanged(state, { ...change, manual: true, enabled: false }), state);

// Navigating to what is discussed keeps following; anywhere else pauses.
assert.equal(routeChanged({ ...state, paused: { turnId: 'turn_0', targetKey: 'x' } }, { ...change, manual: true, showsFocus: true }).paused, null);
let paused = routeChanged(state, { ...change, manual: true });
assert.deepEqual(paused.paused, { turnId: 'turn_1', targetKey: 'login' });

// While paused, the same turn, the same target, and background turns stay put;
// a new topic the user raises resumes.
assert.equal(decideFollow(paused, focus('turn_1', 'docs'), open).show, false);
assert.equal(decideFollow(paused, focus('turn_2', 'login'), open).show, false);
assert.equal(decideFollow(paused, focus('turn_2', 'docs', true), open).show, false);
decision = decideFollow(paused, focus('turn_2', 'docs'), open);
assert.equal(decision.show, true);
assert.equal(decision.state.paused, null);

// Navigating away while the assistant is still answering pauses that turn, so
// its answer does not pull the user back when it ends.
paused = routeChanged(state, { ...change, manual: true, latestTurnId: 'turn_2' });
assert.equal(decideFollow(paused, focus('turn_2', 'docs'), open).show, false);
assert.equal(decideFollow(paused, focus('turn_3', 'docs'), open).show, true);

// Navigating with nothing discussed yet still pauses the turn in progress.
paused = routeChanged(state, { ...change, manual: true, latestTurnId: 'turn_2', focus: null });
assert.deepEqual(paused.paused, { turnId: 'turn_2', targetKey: null });
assert.equal(decideFollow(paused, focus('turn_2', 'docs'), open).show, false);

// When not paused, a background turn about one agent is followed.
assert.equal(decideFollow(state, focus('turn_2', 'docs', true), open).show, true);

// Show from the chip clears the pause and marks the focus shown.
const shown = showRequested(paused, focus('turn_2', 'docs'));
assert.equal(shown.paused, null);
assert.equal(decideFollow(shown, focus('turn_2', 'docs'), open).show, false);

console.log('assistant follow smoke passed');
