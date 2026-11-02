import assert from 'node:assert/strict';

import { memberState } from '../resources/js/lib/agentDigest';
import type { RowActivity } from '../resources/js/lib/rowActivity';

const activity = (self: RowActivity['self']): RowActivity => ({ self, subagents: { working: 0, permission: 0, question: 0, error: 0 } });
assert.equal(memberState(activity('permission')), 'attention');
assert.equal(memberState(activity('error')), 'attention');
assert.equal(memberState(activity('working')), 'working');
assert.equal(memberState(activity('closing')), 'done');
assert.equal(memberState(activity('idle')), 'idle');

console.log('agent digest smoke passed');
