<template>
  <div class="min-w-0">
    <!-- nest: what contains what -->
    <div v-if="layout === 'nest'" class="space-y-2">
      <DrawnNest v-for="item in tree" :key="item.node.id" :item="item" />
    </div>

    <!-- sequence: messages in order between parts -->
    <svg v-else-if="layout === 'sequence'" :viewBox="`0 0 640 ${sequenceHeight}`" class="w-full overflow-visible" role="img" :aria-label="`Sequence of ${diagram.edges?.length ?? 0} messages`">
      <g v-for="(node, index) in diagram.nodes" :key="node.id">
        <rect :x="actorX(index) - 54" y="0" width="108" height="26" rx="6" fill="var(--drawn-card)" :stroke="node.kind === 'external' ? 'var(--drawn-text)' : 'hsl(var(--border))'" :stroke-dasharray="node.kind === 'external' ? '3 3' : undefined" />
        <text :x="actorX(index)" y="17" font-size="12" text-anchor="middle" fill="var(--drawn-fg)">{{ node.label }}</text>
        <line :x1="actorX(index)" :x2="actorX(index)" y1="26" :y2="sequenceHeight" stroke="hsl(var(--border))" stroke-dasharray="2 3" />
      </g>
      <g v-for="(edge, index) in diagram.edges ?? []" :key="index" :opacity="stepCount && index > current ? 0.18 : 1">
        <template v-for="geometry in [messageGeometry(edge, index)]" :key="0">
          <path :d="geometry.d" fill="none" :stroke="geometry.hot ? 'var(--drawn-accent)' : 'var(--drawn-text)'" :stroke-opacity="geometry.hot ? 1 : 0.6" :stroke-width="geometry.hot ? 1.6 : 1.2" :stroke-dasharray="edge.async ? '4 3' : undefined" :marker-end="`url(#${uid}-${geometry.hot ? 'hot' : 'arrow'})`" />
          <text :x="geometry.labelX" :y="geometry.labelY" font-size="11" :text-anchor="geometry.anchor" :fill="geometry.hot ? 'var(--drawn-fg)' : 'var(--drawn-text)'" :font-family="edge.mono ? 'ui-monospace, monospace' : undefined">{{ edge.label ?? '' }}</text>
        </template>
      </g>
      <DrawnArrowDefs :id="uid" />
    </svg>

    <!-- flow: boxes and arrows, laid out by Patterm -->
    <div v-else class="overflow-x-auto">
      <svg :viewBox="`0 0 ${flow.width} ${flow.height}`" :style="{ minWidth: `${Math.min(flow.width, 560)}px` }" class="w-full overflow-visible" role="img" :aria-label="`Diagram of ${diagram.nodes.length} steps`">
        <g v-for="(edge, index) in diagram.edges ?? []" :key="index">
          <template v-for="geometry in [flowEdge(edge)]" :key="0">
            <path v-if="geometry" :d="geometry.d" fill="none" :stroke="hot.has(`${edge.from}>${edge.to}`) ? 'var(--drawn-accent)' : 'var(--drawn-text)'" :stroke-opacity="hot.has(`${edge.from}>${edge.to}`) ? 1 : 0.6" :stroke-width="hot.has(`${edge.from}>${edge.to}`) ? 1.6 : 1.2" :marker-end="`url(#${uid}-${hot.has(`${edge.from}>${edge.to}`) ? 'hot' : 'arrow'})`" />
            <text v-if="geometry && edge.label" :x="geometry.labelX" :y="geometry.labelY" font-size="11" :fill="hot.has(`${edge.from}>${edge.to}`) ? 'var(--drawn-accent)' : 'var(--drawn-text)'">{{ edge.label }}</text>
          </template>
        </g>
        <g v-for="node in diagram.nodes" :key="node.id">
          <template v-for="box in [flow.nodes.get(node.id)!]" :key="0">
            <title v-if="node.note">{{ node.note }}</title>
            <rect :x="box.x" :y="box.y" :width="box.width" :height="box.height" :rx="node.kind === 'store' ? 14 : 7" :fill="hot.has(node.id) ? 'var(--drawn-accent-wash)' : node.tone ? toneWash(node.tone) : 'var(--drawn-card)'" :stroke="hot.has(node.id) ? 'var(--drawn-accent)' : node.tone ? toneColor(node.tone) : 'hsl(var(--border))'" :stroke-dasharray="node.kind === 'external' ? '3 3' : undefined" />
            <foreignObject :x="box.x + 6" :y="box.y + 2" :width="box.width - 12" :height="box.height - 4">
              <div xmlns="http://www.w3.org/1999/xhtml" class="flex h-full flex-col justify-center leading-tight" :class="box.width > 160 ? 'pl-1.5 text-left' : 'text-center'">
                <div class="truncate text-[12.5px] text-foreground" :class="node.kind === 'store' ? 'font-mono text-[12px]' : ''" :title="node.label">{{ node.label }}</div>
                <div v-if="node.sub" class="truncate text-[10.5px] text-muted-foreground" :title="node.sub">{{ node.sub }}</div>
              </div>
            </foreignObject>
          </template>
        </g>
        <DrawnArrowDefs :id="uid" />
      </svg>
    </div>

    <div v-if="stepCount" class="mt-2">
      <p class="min-h-10 text-sm" aria-live="polite">{{ stepText }}</p>
      <div class="mt-2 flex items-center gap-2">
        <span class="mr-auto text-xs text-muted-foreground">Step {{ current + 1 }} of {{ stepCount }}</span>
        <span class="flex gap-1" aria-hidden="true"><i v-for="index in stepCount" :key="index" class="h-[3px] w-4 rounded-full" :class="index - 1 <= current ? 'bg-foreground' : 'bg-border'" /></span>
        <Button size="sm" variant="ghost" class="h-7 px-2.5 text-xs text-muted-foreground" :disabled="current === 0" @click="current--">Back</Button>
        <Button size="sm" variant="outline" class="h-7 px-2.5 text-xs" :disabled="current === stepCount - 1" @click="current++">Next</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import DrawnNest from './DrawnNest.vue';
import { Button } from '../ui/button';
import DrawnArrowDefs from './DrawnArrowDefs.vue';
import { flowEdgePath, layoutFlow, nestTree, toneColor, toneWash } from '../../lib/drawnUi';
import { flowSteps, type DrawnDiagram } from '../../../../app/Services/DrawnUi';

const props = defineProps<{ diagram: DrawnDiagram }>();
type Edge = NonNullable<DrawnDiagram['edges']>[number];
const uid = `drawn-${useId()}`;
const layout = computed(() => props.diagram.layout ?? 'flow');
const current = ref(0);

const tree = computed(() => nestTree(props.diagram.nodes));
const flow = computed(() => layoutFlow(props.diagram));
const stepCount = computed(() => {
  if (!props.diagram.stepThrough) return 0;
  return layout.value === 'sequence' ? props.diagram.edges?.length ?? 0 : steps.value.length;
});
const steps = computed(() => flowSteps(props.diagram));
const stepText = computed(() => layout.value === 'sequence' ? props.diagram.edges?.[current.value]?.text ?? '' : steps.value[current.value]?.text ?? '');
const hot = computed(() => {
  if (layout.value === 'flow' && stepCount.value) return new Set(steps.value[current.value]?.highlight ?? []);
  return new Set([...props.diagram.nodes.filter((node) => node.highlight).map((node) => node.id), ...(props.diagram.edges ?? []).filter((edge) => edge.highlight).map((edge) => `${edge.from}>${edge.to}`)]);
});

function flowEdge(edge: Edge) {
  const from = flow.value.nodes.get(edge.from), to = flow.value.nodes.get(edge.to);
  return from && to ? flowEdgePath(from, to, flow.value.gap, flow.value.direction) : null;
}

const sequenceHeight = computed(() => 34 + (props.diagram.edges?.length ?? 0) * 40 + 6);
function actorX(index: number): number {
  return 60 + index * 520 / Math.max(1, props.diagram.nodes.length - 1);
}
function messageGeometry(edge: Edge, index: number) {
  const ids = props.diagram.nodes.map((node) => node.id);
  const a = actorX(ids.indexOf(edge.from)), b = actorX(ids.indexOf(edge.to));
  const y = 34 + index * 40 + 16;
  const hot = stepCount.value ? index === current.value : Boolean(edge.highlight);
  if (a === b) return { d: `M${a} ${y - 8} H${a + 34} V${y + 8} H${a + 3}`, labelX: a + 40, labelY: y + 4, anchor: 'start', hot };
  return { d: `M${a} ${y} H${b + (b > a ? -3 : 3)}`, labelX: (a + b) / 2, labelY: y - 6, anchor: 'middle', hot };
}
</script>
