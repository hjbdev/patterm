<template>
  <div class="tool-code" :class="{ 'tool-code-numbered': numbered }">
    <template v-for="(group, groupIndex) in groups" :key="groupIndex">
      <div v-if="group.file" class="tool-code-file">
        <span class="text-muted-foreground">{{ folder(group.file) }}</span>{{ base(group.file) }}
        <span class="tool-code-count">{{ group.lines.filter((line) => !line.context).length }}</span>
      </div>
      <div v-for="(line, lineIndex) in group.lines" :key="lineIndex" class="tool-code-line" :class="{ 'tool-code-context': line.context }">
        <span v-if="numbered" class="tool-code-number" aria-hidden="true">{{ line.n }}</span>
        <code><span
          v-for="(segment, segmentIndex) in segments[groupIndex]?.[lineIndex] ?? []"
          :key="segmentIndex"
          :class="segment.mark ? 'tool-code-mark' : undefined"
          :style="segment.color ? { color: segment.color } : undefined"
        >{{ segment.text }}</span></code>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, shallowRef, watch } from 'vue';
import { highlightLines, languageForFile, languageForLine } from '../lib/toolHighlight';
import { markTokens, patternRanges, type CodeGroup, type CodeSegment } from '../lib/toolDetail';

const props = defineProps<{
  groups: CodeGroup[];
  // One language for every line, or a file name to take it from; otherwise
  // each group's file decides.
  lang?: string | undefined;
  langFile?: string | undefined;
  numbered?: boolean;
  // Lines gathered from different places, such as grep hits, highlight alone.
  perLine?: boolean;
  pattern?: string | undefined;
  ignoreCase?: boolean;
}>();

// Plain text first, so the row opens at its final height; colours follow.
const segments = shallowRef<CodeSegment[][][]>(plain());
let version = 0;

function folder(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function plain(): CodeSegment[][][] {
  return props.groups.map((group) => group.lines.map((line) => markTokens([{ content: line.text }], patternRanges(line.text, props.pattern, props.ignoreCase))));
}

async function highlight(): Promise<void> {
  const current = ++version;
  const highlighted = await Promise.all(props.groups.map(async (group) => {
    const texts = group.lines.map((line) => line.text);
    const lang = props.lang ?? (props.langFile ? languageForFile(props.langFile) : props.perLine ? texts.map((text) => languageForLine(group.file, text)) : languageForFile(group.file));
    try { return await highlightLines(texts, lang); } catch { return null; }
  }));
  if (current !== version) return;
  segments.value = props.groups.map((group, groupIndex) => group.lines.map((line, lineIndex) => {
    const tokens = highlighted[groupIndex]?.[lineIndex];
    return markTokens(tokens ?? [{ content: line.text }], patternRanges(line.text, props.pattern, props.ignoreCase));
  }));
}

onMounted(highlight);
watch(() => [props.groups, props.lang, props.langFile, props.pattern], () => {
  segments.value = plain();
  void highlight();
});
</script>
