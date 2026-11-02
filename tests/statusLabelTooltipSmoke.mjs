import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = path => fs.readFileSync(new URL(`../resources/js/Components/${path}`, import.meta.url), 'utf8');

test('Status labels name themselves in an app tooltip, not a native title', () => {
  const pill = read('StatusLabelPill.vue');
  const template = pill.match(/<template>([\s\S]*)<\/template>/)[1];
  assert.match(template, /<Tooltip :open="open" @update:open="open = \$event && !noTooltip">\s*<TooltipTrigger as-child>/);
  // Callers' classes, such as the conversation header's spacing, land on the pill itself.
  assert.match(pill, /defineOptions\(\{ inheritAttrs: false \}\)/);
  assert.equal(template.match(/v-bind="\$attrs"/g)?.length, 2);
  assert.doesNotMatch(template, /:title=/, 'Neither the dot nor the pill falls back to a native title');
  // An empty title keeps a row's own title, such as a member row's name, from showing over the tooltip.
  assert.equal(template.match(/\stitle=""/g)?.length, 2);
  // The dot stays a non-focusable image that screen readers name, owner included.
  assert.match(template, /role="img"\s+:aria-label="description"/);
  assert.doesNotMatch(template, /tabindex/);
  assert.match(pill, /`\$\{props\.label\.name\}, set by you`/);
  assert.match(template, /<p v-if="label\.setBy === 'user'" class="text-muted-foreground">Set by you<\/p>/);
  assert.match(template, /<TooltipContent class="[^"]*bg-popover text-popover-foreground"/);
  // Holding the tooltip closes one already open, so it can't reappear when the hold lifts.
  assert.match(pill, /watch\(\(\) => props\.noTooltip, \(held\) => \{ if \(held\) open\.value = false; \}\);/);
});

test('Tab dots hold their tooltip while the tab menu shows the label', () => {
  const strip = read('TabStrip.vue');
  assert.match(strip, /:label="tab\.family\.root\.session\.statusLabel" dot :no-tooltip="openRootId === tab\.family\.rootId" \/>/);
  // A label always gives the tab a menu, so hovering the dot opens the menu instead.
  assert.match(strip, /\|\| Boolean\(tab\.family\.root\.session\.statusLabel\)/);
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
