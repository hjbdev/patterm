// Sample ui_save inputs for Settings › Figures, drawn by the same components
// as figures in replies.
export const DRAWN_UI_EXAMPLES: ReadonlyArray<{ label: string; spec: unknown }> = [
  {
    label: 'Chart',
    spec: {
      claim: 'Most of a cold start is spent waiting for the terminal host',
      figure: {
        type: 'chart', mark: 'bar', fields: ['phase', 'ms'], x: 'ms', y: 'phase', unit: { x: 'ms' },
        data: [['Open database', 40], ['Start terminal host', 410], ['Load projects', 90], ['First paint', 120, { state: 'projected' }]],
        highlight: { phase: 'Start terminal host' }
      },
      source: 'Example data'
    }
  },
  {
    label: 'Table',
    spec: {
      claim: 'Every harness resumes natively; only some take images',
      figure: {
        type: 'table',
        columns: [{ key: 'harness', label: 'Harness' }, { key: 'resume', label: 'Resume', kind: 'status' }, { key: 'images', label: 'Images', kind: 'status' }, { key: 'trend', label: 'Since last month', kind: 'verdict' }],
        rows: [['Claude Code', 'yes', 'yes', 'better'], ['Codex', 'yes', 'yes', 'same'], ['OpenCode', 'yes', 'partial', 'better']]
      },
      source: 'Example data'
    }
  },
  {
    label: 'Diagram',
    spec: {
      claim: 'A figure travels as data and is drawn by Patterm',
      figure: {
        type: 'diagram', layout: 'flow', stepThrough: true,
        nodes: [{ id: 'agent', label: 'Agent', sub: 'ui_save' }, { id: 'check', label: 'Patterm', sub: 'checks' }, { id: 'reply', label: 'Reply', sub: 'reference' }, { id: 'draw', label: 'Transcript', sub: 'draws' }],
        edges: [
          { from: 'agent', to: 'check', label: 'data', text: 'The agent sends data and meanings, never markup or scripts.' },
          { from: 'check', to: 'reply', label: 'ref', text: 'Patterm validates it and returns a reference such as [patterm_figure:flow].' },
          { from: 'reply', to: 'draw', text: 'The agent puts the reference on its own line, and the figure is drawn there.' }
        ]
      }
    }
  },
  {
    label: 'Sliders',
    spec: {
      claim: 'With {agents} agents, idle compaction saves about {agents * (context - summary)|compact} tokens a day',
      inputs: [{ id: 'agents', label: 'Idle agents', min: 1, max: 20, value: 6 }],
      constants: { context: 180000, summary: 12000 },
      figure: {
        type: 'stats',
        items: [
          { label: 'Without compaction', value: '=agents * context', format: 'compact', unit: 'tokens' },
          { label: 'With compaction', value: '=agents * summary', format: 'compact', unit: 'tokens', tone: 'good' },
          { label: 'Saved', value: '=agents * (context - summary)', format: 'compact', unit: 'tokens', tone: 'accent' }
        ]
      },
      source: 'Example numbers'
    }
  },
  {
    label: 'Choice',
    spec: {
      claim: 'Two ways to share a figure outside Patterm',
      figure: {
        type: 'choice',
        options: [
          { value: 'image', label: 'Export as an image', pros: ['Pastes anywhere'], cons: ['Loses sliders and steps'], pick: true },
          { value: 'page', label: 'Publish a page', pros: ['Stays interactive'], cons: ['Needs hosting'] }
        ]
      }
    }
  }
];
