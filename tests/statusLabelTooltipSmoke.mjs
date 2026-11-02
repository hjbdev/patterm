import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = path => fs.readFileSync(new URL(`../resources/js/Components/${path}`, import.meta.url), 'utf8');

test('Status labels name themselves in an app tooltip, not a native title', () => {
  const pill = read('StatusLabelPill.vue');
  const template = pill.match(/<template>([\s\S]*)<\/template>/)[1];
  assert.match(template, /<Tooltip>\s*<TooltipTrigger as-child>/);
  assert.doesNotMatch(template, /:title=/, 'Neither the dot nor the pill falls back to a native title');
  // An empty title keeps a row's own title, such as a member row's name, from showing over the tooltip.
  assert.equal(template.match(/\stitle=""/g)?.length, 2);
  // The dot stays a non-focusable image that screen readers name, owner included.
  assert.match(template, /role="img"\s+:aria-label="description"/);
  assert.doesNotMatch(template, /tabindex/);
  assert.match(pill, /`\$\{props\.label\.name\}, set by you`/);
  assert.match(template, /<p v-if="label\.setBy === 'user'" class="text-muted-foreground">Set by you<\/p>/);
  assert.match(template, /<TooltipContent :side="side \?\? 'top'" class="[^"]*bg-popover text-popover-foreground"/);
});

test('Tab dots keep their tooltip clear of the menu below the tab', () => {
  assert.match(read('TabStrip.vue'), /:label="tab\.family\.root\.session\.statusLabel" dot side="right" \/>/);
});

test('The sidebar agent card shows the full status badge, and dots for its members', () => {
  const card = read('Sidebar/AgentCard.vue');
  assert.match(card, /<div v-if="digest\.session\.statusLabel" class="ml-\[26px\] mt-1\.5 flex">\s*<StatusLabelPill :label="digest\.session\.statusLabel" \/>/);
  assert.match(read('Sidebar/AgentCardMember.vue'), /<StatusLabelPill v-if="member\.session\?\.statusLabel" :label="member\.session\.statusLabel" dot \/>/);
  // The tab's menu already showed the full badge, for the root and each subagent.
  const menu = read('AgentFamilyMenu.vue');
  assert.match(menu, /<StatusLabelPill :label="family\.root\.session\.statusLabel" \/>/);
  assert.match(menu, /<StatusLabelPill v-if="option\.session\.statusLabel" :label="option\.session\.statusLabel" \/>/);
});
