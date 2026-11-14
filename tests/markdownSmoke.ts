import assert from 'node:assert/strict';
import { renderMarkdown, renderPlainMarkdown } from '../resources/js/lib/markdown';

async function main(): Promise<void> {
  const highlighted = await renderMarkdown('```js\nconsole.log("code block");\n```');
  assert.match(highlighted, /<span style="color:/, 'known languages receive syntax colours');
  assert.doesNotMatch(highlighted, /<pre[^>]*style=/, 'the app controls the code block surface');
  assert.match(highlighted, /^<div class="code-block"><pre[\s\S]*<\/pre>\n?<\/div>/, 'highlighted code blocks sit in a wrapper for the copy button');
  assert.match(renderPlainMarkdown('```\nplain\n```'), /^<div class="code-block"><pre><code>plain\n<\/code><\/pre>\n<\/div>/, 'plain code blocks sit in the same wrapper');
  const escaped = await renderMarkdown('```unknown-language\n<script>alert(1)</script>\n```\n\n<script>alert(2)</script>\n\n[bad](javascript:alert(3))');
  assert.doesNotMatch(escaped, /<script|href="javascript:/);
  assert.match(escaped, /&lt;script&gt;/);
  assert.match(await renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```'), /&(?:lt|#x3C);/);
  assert.doesNotMatch(await renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```'), /<img/);
  assert.match(await renderMarkdown('[Example](https://example.com)'), /target="_blank" rel="noopener noreferrer"/);
  const fileReference = '[StoresDemoAnalysis.php](file:///home/harry/Dev/stratbase/app/Jobs/Demos/Concerns/StoresDemoAnalysis.php#L58-L65)';
  for (const render of [renderPlainMarkdown, renderMarkdown]) {
    const html = await render(`**Analysis** in ${fileReference}.`);
    assert.match(html, /<strong>Analysis<\/strong> in <span [^>]*>StoresDemoAnalysis.php<\/span>\./, 'Antigravity file references render their label rather than raw Markdown');
    assert.match(html, /title="file:\/\/\/home\/harry\/Dev\/stratbase\/app\/Jobs\/Demos\/Concerns\/StoresDemoAnalysis.php#L58-L65"/, 'the file path and line range remain available on hover');
    assert.doesNotMatch(html, /(?:href|src)="file:/i, 'file references cannot navigate or load local resources');
  }
  assert.match(renderPlainMarkdown('[`worker.yml`](FILE:///C:/repo/worker.yml#L109-L123)'), /<span [^>]*><code>worker.yml<\/code><\/span>/, 'file references preserve inline formatting and Windows paths');
  assert.match(renderPlainMarkdown('[worker][config]\n\n[config]: file:///repo/worker.yml#L109-L123'), /<span [^>]*>worker<\/span>/, 'reference-style file links render too');
  assert.match(renderPlainMarkdown('<file:///repo/worker.yml#L109>'), /<span [^>]*>file:\/\/\/repo\/worker.yml#L109<\/span>/, 'explicit autolinks remain non-navigable');
  assert.match(renderPlainMarkdown('[process_12](file:///repo/process_12)', { mentions: true }), /<span [^>]*>process_12<\/span>/, 'file reference labels are not mistaken for process mentions');
  assert.doesNotMatch(renderPlainMarkdown('![private](file:///etc/passwd) ![remote](file://remote/share/image.png)'), /<img/, 'allowing file references never enables local or network file images');
  assert.equal(renderPlainMarkdown('![private][image]\n\n[image]: FILE:///etc/passwd'), '<p>private</p>\n', 'reference-style file images fall back to escaped alt text');
  assert.match(renderPlainMarkdown('[file](file:///repo/file) [Example](https://example.com)'), /<\/span> <a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">Example<\/a>/, 'a file reference does not change the next web link');
  for (const render of [renderPlainMarkdown, renderMarkdown]) {
    for (const nested of ['https://example.com', 'file:///repo/inner#L3']) {
      const html = await render(`[outer <${nested}>](file:///repo/outer#L1-L2) after **bold** [next](https://next.example) process_14`, { mentions: true });
      assert.match(html, /<\/(?:a|span)><\/span> after <strong>bold<\/strong> <a href="https:\/\/next.example" target="_blank" rel="noopener noreferrer">next<\/a> <span data-mention="process_14"><\/span>/, 'nested autolinks close the outer file reference before following text, links and mentions');
      assert.doesNotMatch(html, /(?:href|src)="file:/i, 'nested file references remain inert');
    }
    assert.match(await render('[outer <file:///repo/inner>](https://outer.example) after'), /<\/span><\/a> after/, 'a nested file reference preserves the closing tag of an outer web link');
  }
  assert.match(renderPlainMarkdown('| File |\n| --- |\n| [worker](file:///repo/worker.yml#L109) |'), /<td><span [^>]*>worker<\/span><\/td>/, 'file references also render inside tables');
  assert.match(renderPlainMarkdown('`[file](file:///repo/file)`\n\n```md\n[file](file:///repo/file)\n```'), /<code>\[file\]\(file:\/\/\/repo\/file\)<\/code>/, 'examples of Markdown links remain literal code');
  assert.doesNotMatch(renderPlainMarkdown('[file](<file:///repo/"onmouseover=alert(1)> "ignored title")'), /(?:\s|<)onmouseover=|href=/, 'file reference paths cannot inject attributes');
  const unsafeLinks = renderPlainMarkdown('[js](javascript:alert(1)) [vb](vbscript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)');
  assert.doesNotMatch(unsafeLinks, /<(?:a|span)\b/, 'other blocked URL schemes remain rejected');
  assert.doesNotMatch(await renderMarkdown('```js\n' + 'x'.repeat(20_001) + '\n```'), /class="shiki/);
  const mentions = (source: string) => renderPlainMarkdown(source, { mentions: true });
  assert.equal(mentions('Ask process_12 or `process_3`.'), '<p>Ask <span data-mention="process_12"></span> or <span data-mention="process_3"></span>.</p>\n', 'process IDs in text and whole code spans become placeholders');
  assert.match(mentions('Use [patterm_preset:claude/Smarty pants], [patterm_preset:Quick] or [patterm_harness:codex]'),
    /<span data-mention="\[patterm_preset:claude\/Smarty pants\]"><\/span>, <span data-mention="\[patterm_preset:Quick\]"><\/span> or <span data-mention="\[patterm_harness:codex\]"><\/span>/, 'launch tokens become placeholders');
  assert.match(mentions('`send_message process_4`'), /<code>send_message process_4<\/code>/, 'code that holds more than a mention stays code');
  assert.match(mentions('```\nprocess_5 [patterm_harness:codex]\n```'), /<code>process_5 \[patterm_harness:codex\]\n<\/code>/, 'code blocks stay code');
  assert.match(mentions('[process_6](https://example.com) https://example.com/process_7'), /<a [^>]*>process_6<\/a> <a [^>]*>https:\/\/example.com\/process_7<\/a>/, 'link text stays text');
  assert.doesNotMatch(mentions('myprocess_8 process_9abc'), /data-mention/, 'only whole process IDs match');
  assert.doesNotMatch(renderPlainMarkdown('process_10 [patterm_harness:codex]'), /data-mention/, 'mentions are opt-in');
  const streaming = (source: string) => renderPlainMarkdown(source, { mentions: true, holdTrailing: true });
  assert.equal(streaming('Ask process_1 and process_2'), '<p>Ask <span data-mention="process_1"></span> and process_2</p>\n', 'a streaming reply holds back only an ID at its very end');
  assert.match(streaming('Ask process_1\n\nThen process_2'), /<p>Ask <span data-mention="process_1"><\/span><\/p>\n<p>Then process_2<\/p>/, 'only the last block holds back');
  assert.match(streaming('Use [patterm_harness:codex]'), /data-mention="\[patterm_harness:codex\]"/, 'a launch token is complete once its bracket closes');
  assert.match(await renderMarkdown('process_11\n\n```js\nx\n```', { mentions: true }), /data-mention="process_11"/, 'highlighted Markdown keeps placeholders');
  console.log('markdown smoke ok');
}
void main();
