import assert from 'node:assert/strict';

import { takeFreshRequests } from '../resources/js/lib/secretRequests';

const secret = (id: string, status: 'requested' | 'ready') => ({ id, status });
const seen = new Set<string>();

// A request draws attention once; ready secrets never do.
assert.deepEqual(takeFreshRequests([secret('a', 'requested'), secret('b', 'ready')], seen), ['a']);
assert.deepEqual(takeFreshRequests([secret('a', 'requested'), secret('b', 'ready')], seen), []);
// A later request does, even beside one already shown.
assert.deepEqual(takeFreshRequests([secret('a', 'requested'), secret('c', 'requested')], seen), ['c']);
// Filling a request and the agent asking again with a new one shows the new one.
assert.deepEqual(takeFreshRequests([secret('a', 'ready'), secret('d', 'requested')], seen), ['d']);

console.log('secret request smoke passed');
