// The Integrated composer's editor: Tiptap set up as a plain-text box whose
// only other content is mention chips: agents, processes, presets, and harnesses. The composer works in offsets into the
// draft text (see composerDocument), so its menu logic reads as it would for
// a text box.

import { Editor, Extension, Node, VueNodeViewRenderer } from '@tiptap/vue-3';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import ComposerMention from '../Components/ComposerMention.vue';
import { composerChips, composerLines, composerText, positionToTextOffset, textOffsetToPosition, type ComposerChip, type ComposerLine } from './composerDocument';

export interface ComposerEditor {
  readonly tiptap: Editor;
  getText(): string;
  getSelection(): { start: number; end: number };
  // Replaces the text between two offsets and puts the caret after what was
  // inserted. A chip is followed by a space.
  replace(start: number, end: number, insert: string | ComposerChip): void;
  // Shows a draft that changed elsewhere, without reporting it as an edit.
  setText(text: string, chips: readonly ComposerChip[]): void;
  focus(): void;
  // Reads the placeholder and attributes again.
  refresh(): void;
  destroy(): void;
}

export interface ComposerEditorOptions {
  text: string;
  chips: readonly ComposerChip[];
  placeholder: () => string;
  attributes: () => Record<string, string>;
  onChange: (text: string, chips: ComposerChip[]) => void;
  onSelectionChange: () => void;
  // Each returns true when it handled the event.
  onKeyDown: (event: KeyboardEvent) => boolean;
  onPaste: (event: ClipboardEvent) => boolean;
  onDrop: (event: DragEvent) => boolean;
  onBlur: () => void;
}

const MENTION = 'agentMention';

const AgentMention = Node.create({
  name: MENTION,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      kind: { default: 'agent', parseHTML: (element) => element.getAttribute('data-kind') ?? 'agent', renderHTML: (attributes) => ({ 'data-kind': attributes.kind }) },
      token: { default: '', parseHTML: (element) => element.getAttribute('data-token') ?? '', renderHTML: (attributes) => ({ 'data-token': attributes.token }) },
      name: { default: '', parseHTML: (element) => element.getAttribute('data-name') ?? '', renderHTML: (attributes) => ({ 'data-name': attributes.name }) },
      harness: { default: null, parseHTML: (element) => element.getAttribute('data-harness'), renderHTML: (attributes) => attributes.harness ? { 'data-harness': attributes.harness } : {} }
    };
  },
  // Copied chips paste back as chips, and as `@title` elsewhere.
  parseHTML() {
    return [{ tag: 'span[data-agent-mention]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-agent-mention': '' }, `@${node.attrs.name}`];
  },
  renderText({ node }) {
    return `@${node.attrs.name}`;
  },
  addNodeView() {
    return VueNodeViewRenderer(ComposerMention);
  }
});

// Enter belongs to the composer, so Shift+Enter starts a new line. Backspace
// and Delete beside a chip remove the whole chip, which browsers do not all do
// for an uneditable element.
const ComposerKeys = Extension.create({
  name: 'composerKeys',
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => this.editor.commands.splitBlock(),
      Backspace: () => removeChip(this.editor, -1),
      Delete: () => removeChip(this.editor, 1)
    };
  }
});

function removeChip(editor: { view: Editor['view'] }, direction: -1 | 1): boolean {
  const { state } = editor.view;
  const { empty, $head, head } = state.selection;
  const node = direction < 0 ? $head.nodeBefore : $head.nodeAfter;
  if (!empty || node?.type.name !== MENTION) return false;
  const from = direction < 0 ? head - node.nodeSize : head;
  editor.view.dispatch(state.tr.delete(from, from + node.nodeSize));
  return true;
}

function linesOf(doc: ProseMirrorNode): ComposerLine[] {
  const lines: ComposerLine[] = [];
  doc.forEach((paragraph) => {
    const line: ComposerLine = [];
    paragraph.forEach((child) => {
      if (child.isText) line.push({ text: child.text ?? '' });
      else if (child.type.name === MENTION) line.push({ chip: { kind: child.attrs.kind, token: String(child.attrs.token), name: String(child.attrs.name), harness: child.attrs.harness ?? null } });
    });
    lines.push(line);
  });
  return lines;
}

function documentJSON(lines: readonly ComposerLine[]) {
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      ...(line.length ? { content: line.map((item) => 'chip' in item ? { type: MENTION, attrs: { ...item.chip } } : { type: 'text', text: item.text }) } : {})
    }))
  };
}

export function createComposerEditor(options: ComposerEditorOptions): ComposerEditor {
  const tiptap = new Editor({
    extensions: [Document, Paragraph, Text, AgentMention, ComposerKeys, UndoRedo, Placeholder.configure({ placeholder: () => options.placeholder() })],
    content: documentJSON(composerLines(options.text, options.chips)),
    editorProps: {
      attributes: () => options.attributes(),
      handleKeyDown: (_view, event) => options.onKeyDown(event),
      handlePaste: (_view, event) => options.onPaste(event),
      handleDrop: (_view, event) => options.onDrop(event)
    },
    onUpdate: () => {
      const lines = linesOf(tiptap.view.state.doc);
      options.onChange(composerText(lines), composerChips(lines));
    },
    // Edits report through onUpdate, which follows with the new text.
    onSelectionUpdate: ({ transaction }) => {
      if (!transaction.docChanged) options.onSelectionChange();
    },
    onBlur: () => options.onBlur()
  });
  const getText = (): string => composerText(linesOf(tiptap.view.state.doc));

  return {
    tiptap,
    getText,
    getSelection() {
      const text = getText();
      const { from, to } = tiptap.view.state.selection;
      return { start: positionToTextOffset(text, from), end: positionToTextOffset(text, to) };
    },
    replace(start, end, insert) {
      const text = getText();
      const from = textOffsetToPosition(text, start);
      const to = textOffsetToPosition(text, end);
      const { state } = tiptap.view;
      const tr = state.tr;
      if (typeof insert === 'string') tr.insertText(insert, from, to);
      else tr.replaceWith(from, to, [state.schema.nodes[MENTION]!.create({ ...insert }), state.schema.text(' ')]);
      const caret = from + (typeof insert === 'string' ? insert.length : 2);
      tiptap.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView());
    },
    setText(text, chips) {
      const { state } = tiptap.view;
      const doc = state.schema.nodeFromJSON(documentJSON(composerLines(text, chips)));
      const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta('preventUpdate', true);
      tiptap.view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)));
    },
    focus() {
      tiptap.commands.focus(undefined, { scrollIntoView: false });
    },
    refresh() {
      tiptap.view.dispatch(tiptap.view.state.tr);
    },
    destroy() {
      tiptap.destroy();
    }
  };
}
