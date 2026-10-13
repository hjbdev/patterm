// Pages shown in Settings › Figures, written the way agents are asked to:
// no background or title, theme variables, fixed chart heights.

export interface FigureExample { label: string; page: { title: string; html: string; height: number } }

const chart = `<!doctype html><html><head><style>
.legend{display:flex;gap:16px;margin-bottom:8px;color:var(--muted-foreground);font-size:12px}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
svg{display:block;width:100%;height:220px}
text{fill:var(--muted-foreground);font-size:11px}
</style></head><body>
<div class="legend"><span><i style="background:var(--chart-1)"></i>Cold start</span><span><i style="background:var(--chart-2)"></i>Warm start</span></div>
<svg id="chart" role="img" aria-label="Start time by harness"></svg>
<script>
const rows = [['Claude', 2.4, 0.9], ['Codex', 3.1, 1.2], ['OpenCode', 1.8, 0.6]];
const svg = document.getElementById('chart');
const draw = () => {
  const width = svg.clientWidth, height = 220, left = 72, max = 3.5;
  const band = (height - 24) / rows.length;
  svg.innerHTML = rows.map(([name, cold, warm], index) => {
    const y = index * band + 8, scale = (value) => (width - left - 40) * value / max;
    return '<text x="0" y="' + (y + band / 2) + '">' + name + '</text>'
      + '<rect x="' + left + '" y="' + (y + 4) + '" width="' + scale(cold) + '" height="' + (band / 2 - 6) + '" rx="3" fill="var(--chart-1)"/>'
      + '<rect x="' + left + '" y="' + (y + band / 2) + '" width="' + scale(warm) + '" height="' + (band / 2 - 6) + '" rx="3" fill="var(--chart-2)"/>'
      + '<text x="' + (left + scale(cold) + 6) + '" y="' + (y + band / 4 + 4) + '">' + cold + ' s</text>';
  }).join('');
};
new ResizeObserver(draw).observe(svg);
</script></body></html>`;

const table = `<!doctype html><html><head><style>
td.num{text-align:right}
.good{color:var(--success)}.bad{color:var(--destructive)}.note{color:var(--muted-foreground)}
</style></head><body>
<table>
<thead><tr><th>Check</th><th>Result</th><th class="num">Time</th></tr></thead>
<tbody>
<tr><td>Typecheck</td><td class="good">Passed</td><td class="num">41 s</td></tr>
<tr><td>Smoke tests</td><td class="good">Passed</td><td class="num">3 min 12 s</td></tr>
<tr><td>Sidecar</td><td class="bad">1 failure</td><td class="num">58 s</td></tr>
<tr><td>Notices</td><td class="note">Skipped, no dependency changes</td><td class="num">–</td></tr>
</tbody></table></body></html>`;

const choice = `<!doctype html><html><head><style>
.options{display:grid;gap:8px}
button.option{display:block;width:100%;text-align:left;padding:12px 14px;border-radius:var(--radius)}
button.option strong{display:block;font-weight:500}
button.option span{color:var(--muted-foreground);font-size:13px}
p.status{margin:10px 0 0;color:var(--muted-foreground);font-size:12px}
</style></head><body>
<div class="options">
<button class="option" data-value="export"><strong>Export as an image</strong><span>One PNG per figure, attached to the reply.</span></button>
<button class="option" data-value="publish"><strong>Publish a page</strong><span>A shareable link that keeps the page interactive.</span></button>
</div>
<p class="status" id="status"></p>
<script>
const status = document.getElementById('status');
const buttons = [...document.querySelectorAll('button.option')];
const refresh = () => {
  const answered = patterm.answered('share_format');
  buttons.forEach((button) => { button.disabled = Boolean(answered) || !patterm.canAnswer; });
  status.textContent = answered ? 'Answered.' : patterm.canAnswer ? '' : 'Answers are sent from a live conversation.';
};
buttons.forEach((button) => button.addEventListener('click', () => {
  patterm.answer('share_format', { label: button.querySelector('strong').textContent, value: button.dataset.value })
    .catch((error) => { status.textContent = error.message; });
}));
patterm.onChange(refresh);
refresh();
</script></body></html>`;

export const FIGURE_EXAMPLES: FigureExample[] = [
  { label: 'Chart', page: { title: 'Start time by harness', html: chart, height: 260 } },
  { label: 'Table', page: { title: 'Checks on this branch', html: table, height: 180 } },
  { label: 'Question', page: { title: 'How should figures be shared?', html: choice, height: 170 } }
];
