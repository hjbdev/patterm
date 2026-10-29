import assert from 'node:assert/strict';

import { familyServers, linkPort, processPort, serverLabel } from '../resources/js/lib/servers';

const proc = (id: string, name: string, command = '') => ({ id, name, command });
const link = (id: string, url: string) => ({ id, url });

// A process's port comes from its name, then its command line.
assert.equal(processPort(proc('a', 'stratbase site :8885')), '8885');
assert.equal(processPort(proc('a', 'dev', 'pnpm dev --port 8019')), '8019');
assert.equal(processPort(proc('a', 'site', 'python3 -m http.server 8885 --bind 100.96.33.3')), '8885');
assert.equal(processPort(proc('a', 'watcher', 'pnpm run watch')), null);

assert.equal(linkPort('http://100.96.33.3:8885/'), '8885');
assert.equal(linkPort('https://preview.example.com/'), null);
assert.equal(linkPort('not a url'), null);
assert.equal(serverLabel('stratbase site :8885', '8885'), 'stratbase site');
assert.equal(serverLabel(':8885', '8885'), ':8885');

// Each process pairs with the preview link on its port; links that pair with
// none follow, under their own label.
const servers = familyServers(
  [proc('p1', 'site :8885'), proc('p2', 'worker', 'node worker.js')],
  [link('r1', 'https://deploy.example.com/'), link('r2', 'http://100.96.33.3:8885/')],
  (item) => `link ${item.id}`
);
assert.deepEqual(servers.map((server) => [server.key, server.label, server.port, server.url]), [
  ['p1', 'site', '8885', 'http://100.96.33.3:8885/'],
  ['p2', 'worker', null, null],
  ['r1', 'link r1', null, 'https://deploy.example.com/']
]);

console.log('servers smoke passed');
