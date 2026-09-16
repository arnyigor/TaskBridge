import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseHTML } from 'linkedom';

// An id selector that sets `display` outweighs the `.hidden` class, so a rule
// like `#thing { display: flex }` on an element marked hidden leaves an empty
// box on screen. That mistake happened twice; this test is the guard.

test('no id rule with display can defeat the hidden class', async () => {
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const { document } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));

  const offenders = [];
  for (const match of css.matchAll(/^#([A-Za-z0-9_-]+)([^\n{]*)\{([^}]*)\}/gm)) {
    const [, id, selectorTail, declarations] = match;
    if (!/display\s*:/.test(declarations)) continue;
    if (/\.hidden/.test(selectorTail) || /hidden/.test(declarations)) continue;
    const element = document.getElementById(id);
    if (element && element.classList.contains('hidden')) offenders.push(`#${id} { ${declarations.match(/display\s*:[^;]*/)[0].trim()} }`);
  }
  assert.deepEqual(offenders, [], `guard these with :not(.hidden) or remove the display rule:\n${offenders.join('\n')}`);
});

test('code-block actions are reachable without a hover (touch screens)', async () => {
  // On desktop they fade in on hover; a phone has no hover, so without this the
  // copy/run controls would be invisible there.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const block = css.match(/@media \(hover:\s*none\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'a hover:none block exists');
  assert.match(block[1], /codeCopyBtn/);
  assert.match(block[1], /opacity:\s*1/);
});

test('a queued prompt is shown on one line, however long it is', async () => {
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const rule = css.match(/\.queuedPrompt \.queuedText\s*\{([^}]*)\}/);
  assert.ok(rule, 'the queued text has a rule');
  assert.match(rule[1], /white-space:\s*nowrap/, 'no wrapping');
  assert.match(rule[1], /text-overflow:\s*ellipsis/, 'truncated with an ellipsis');
});

test('a wide table scrolls inside its own box, not the whole chat', async () => {
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const wrapper = css.match(/\.md \.tableWrap\s*\{([^}]*)\}/);
  assert.ok(wrapper, 'the table wrapper has a rule');
  assert.match(wrapper[1], /overflow-x:\s*auto/, 'horizontal scroll for a wide table');
  const table = css.match(/\.md table\s*\{([^}]*)\}/);
  assert.ok(table, 'the table has a rule');
  assert.match(table[1], /width:\s*max-content/, 'columns keep their content width instead of being squeezed');
});

test('the file viewer dialog is not capped by the small wide-card width', async () => {
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  // The card also carries `.authCard.wide` (max-width: 520px); only a selector of
  // equal-or-higher specificity can raise it — a single-class `.fileViewerCard`
  // rule silently lost, which is why the dialog stayed small.
  assert.match(css, /\.authCard\.fileViewerCard\s*\{[^}]*max-width:\s*900px/, 'the viewer card raises its width with two classes');
  assert.doesNotMatch(css, /^\.fileViewerCard\s*\{/m, 'a single-class rule would lose to .authCard.wide');
});

test('the font scale is a root font size, not a whole-UI zoom', async () => {
  // `zoom` on the body either overflows the viewport (the app is laid out at
  // 100dvh and then drawn 1.15x taller, so the composer ends up off screen) or,
  // with the box divided by the factor, leaves the app ~87% wide. A root
  // font-size scales the text without touching the layout box — and it only
  // reaches the text because every font-size in the sheet is in rem.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /zoom:\s*var\(--ui-scale/, 'no whole-UI zoom');
  assert.match(css, /html\s*\{[^}]*font-size:\s*calc\(16px \* var\(--ui-scale/, 'the root font size carries the scale');
  const pxFontSizes = css.match(/font-size:\s*[\d.]+px/g) || [];
  assert.deepEqual(pxFontSizes, [], 'every font-size is in rem, otherwise the root font size would miss it');
});

test('an element hidden in the markup starts hidden in every mode', async () => {
  const { document } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  // The mode banner only ever gets text from startCloudMode(); in a local page it
  // must stay invisible.
  const banner = document.getElementById('modeBanner');
  assert.ok(banner, 'the cloud mode banner exists');
  assert.equal(banner.classList.contains('hidden'), true);
  assert.equal(banner.textContent.trim(), '');
});
