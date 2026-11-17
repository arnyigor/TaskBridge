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
  assert.match(table[1], /width:\s*100%/, 'a table fills the bubble when the content fits');
  assert.match(table[1], /min-width:\s*max-content/, 'and is never squeezed below its content');
  assert.match(css, /\.md tbody tr:nth-child\(even\)/, 'zebra rows keep a wide table readable');
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

test('a block marked hidden in the markup is not given a display later in the sheet', async () => {
  // `.hidden { display: none }` only wins until an equally specific rule that
  // comes later sets `display` — the same trap the id-guard above catches, with
  // classes. `#approvalBanner` sat that way for a while: an empty 16px strip on
  // every page (an approval banner has no content when nothing is pending).
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const { document } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  const anchor = /^\.hidden\s*\{/m.exec(css);
  assert.ok(anchor, 'the .hidden rule exists');
  const after = css.slice(anchor.index);
  const offenders = [];
  for (const match of after.matchAll(/([^{}@/]+)\{([^}]*)\}/g)) {
    if (!/display\s*:/.test(match[2])) continue;
    const selector = match[1].trim().replace(/\s+/g, ' ');
    if (/hidden/.test(selector) || selector.includes('::')) continue; // guarded, or not the element itself
    for (const element of document.querySelectorAll('.hidden')) {
      let hit = false;
      try { hit = element.matches(selector); } catch { hit = false; }
      if (hit) offenders.push(`${element.id || element.className} <- ${selector}`);
    }
  }
  assert.deepEqual(offenders, [], `guard these with :not(.hidden), or the block takes space while empty:\n${offenders.join('\n')}`);
});

test('a phone-width status row never prints over its own buttons', async () => {
  // The row carries the badge, the status, the copy icon, the times and up to
  // four action buttons — more than 390px of content. With a zero flex basis the
  // status was squeezed to ~20px, its text escaped the box and painted over the
  // copy icon (seen on the phone, not in any test).
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const row = css.match(/\.metaRow\s*\{([^}]*)\}/);
  assert.ok(row, 'the status row has a rule');
  assert.match(row[1], /flex-wrap:\s*wrap/, 'the action buttons can move to their own line');
  const meta = css.match(/\.metaRow > \.meta\s*\{([^}]*)\}/);
  assert.ok(meta, 'the status inside that row has its own rule');
  assert.match(meta[1], /flex:\s*1 1 auto/, 'a content basis, or the row believes it fits');
  assert.match(meta[1], /overflow:\s*hidden/);
  assert.match(meta[1], /text-overflow:\s*ellipsis/);
});

test('the message editor opens with room to write in', async () => {
  // Seven lines of answer used to open in a 72px box — three lines on a phone —
  // and the operator could not see the text they were correcting.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const area = css.match(/\.editArea\s*\{([^}]*)\}/);
  assert.ok(area, 'the editor has a rule');
  const minHeight = Number((area[1].match(/min-height:\s*(\d+)px/) || [])[1]);
  assert.ok(minHeight >= 120, `the editor must open tall enough to read: ${minHeight}px`);
  assert.match(area[1], /resize:\s*vertical/, 'and still be resizable for a one-word fix');
});

test('the status dot has a tap target a thumb can hit', async () => {
  // The operator could not hit it: 12px on a phone is not a target. The box is a
  // target now and the painted circle is clipped to the content box, so the dot
  // stays small while the thing you press grew.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const mobile = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
  assert.ok(mobile, 'a phone-width block exists');
  const rule = mobile[1].match(/\.pcState > summary\.statusDot\s*\{([^}]*)\}/);
  assert.ok(rule, 'the dot has a phone rule of its own');
  const width = Number((rule[1].match(/width:\s*(\d+)px/) || [])[1]);
  assert.ok(width >= 40, `the tap target must be at least 40px, not ${width}px`);
  assert.match(rule[1], /background-clip:\s*content-box/, 'the painted dot stays small inside the big target');
  assert.match(rule[1], /padding:\s*\d+px/, 'the padding is what makes the target');
});

test('the status dot opens a panel instead of drawing a disclosure marker', async () => {
  // The dot is a <details> now, and its summary must stay a plain coloured
  // circle: the UA would otherwise draw a disclosure triangle next to it.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.pcState > summary\.statusDot\s*\{[^}]*list-style:\s*none/, 'no marker');
  assert.match(css, /\.pcState > summary::-webkit-details-marker\s*\{\s*display:\s*none/);
  const panel = css.match(/\.pcStateBody\s*\{([^}]*)\}/);
  assert.ok(panel, 'the panel has a rule');
  assert.match(panel[1], /position:\s*absolute/);
  assert.match(panel[1], /background:\s*var\(--panel/, 'opaque: it hangs over the conversation');
  assert.match(panel[1], /max-width:\s*92vw/, 'and has to fit a phone');
  assert.match(panel[1], /white-space:\s*pre-line/, 'the text is lines of state and addresses');
});

test('the header menu is opaque, and its rows are controls rather than glyphs', async () => {
  // The menu hangs over the conversation: a translucent panel let the chat text
  // read through the controls, and the icon buttons kept their header size
  // (30px, or no box at all for the restart glyph), so the menu looked like a
  // column of floating icons.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const body = css.match(/\.headerMenuBody\s*\{([^}]*)\}/);
  assert.ok(body, 'the menu body has a rule');
  assert.match(body[1], /background:\s*var\(--panel/, 'an opaque panel, not a translucent one');
  // .iconButton and .bareIcon are declared later in the file: without the extra
  // class the menu's row rules lose to their fixed size, and a bare glyph keeps
  // no box.
  assert.match(css, /\.headerMenu \.headerMenuBody > button:not\(\.hidden\)/, 'rows win over .iconButton');
  assert.match(css, /\.headerMenu \.headerMenuBody > button\.bareIcon/, 'and over .bareIcon, which has no box of its own');
  assert.match(css, /content:\s*attr\(aria-label\)/, 'an icon-only row gets its label as text');
  // The model row is in the menu on a phone, and the header hides its "Модель:"
  // label there: without this the first row of the menu is a bare model name
  // with nothing saying what it is.
  assert.match(css, /\.headerMenu \.headerMenuBody \.modelChipLabel\s*\{\s*display:\s*inline/, 'the model row is labelled inside the menu');
  assert.match(css, /\.headerMenu \.headerMenuBody > \.modelChip\s*\{[^}]*max-width:\s*100%/, 'and fills the row like the others');
});

test('the phone layout keeps its safe-area insets where a later rule would drop them', async () => {
  // `.top` and `.composer-wrap` are both re-padded inside the phone blocks, with
  // equal specificity and later in the file. Those rules silently replaced the
  // base padding — env() and all — so the insets have to be repeated there.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const block = (query) => {
    const match = css.match(new RegExp(`@media \\(${query}\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(match, `a ${query} block exists`);
    return match[1];
  };
  const mobile = block('max-width: 900px');
  assert.match(mobile, /\.top\s*\{[^}]*env\(safe-area-inset-top/, 'the header clears the status bar');
  assert.match(mobile, /\.controlsSpoiler\[open\] > summary\s*\{[^}]*env\(safe-area-inset-top/, 'and so does the drawer handle');
  const narrow = block('max-width: 480px');
  assert.match(narrow, /\.composer-wrap\s*\{[^}]*env\(safe-area-inset-bottom/, 'the composer clears the gesture bar');
});

test('the header menu is shown exactly where app.js fills it', async () => {
  // app.js moves the secondary controls into the menu below 900px; the CSS has
  // to use the same single bound. Written as `min-width: 901px` it left a
  // 900 < w < 901 band where the menu was drawn (empty, 32px wide) while the
  // controls had stayed in the header.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const mobile = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
  assert.ok(mobile, 'a phone-width block exists');
  assert.match(mobile[1], /\.headerMenu\[data-ready\]\s*\{\s*display:\s*block/, 'the phone block shows the menu app.js filled');
  assert.doesNotMatch(css, /min-width:\s*901px/, 'no second, off-by-one bound');
  const displays = [...css.matchAll(/\.headerMenu(?:\[[^\]]*\])?\s*\{[^}]*display:\s*(\w+)/g)].map(match => match[1]);
  assert.deepEqual(displays, ['none', 'block'], 'no other rule gives the menu a display');
});

test('on a phone the session list is a drawer over the chat, not a block above it', async () => {
  // The list is the tallest piece of chrome on the page: as a block it pushed
  // the conversation into a third of the screen. The markup keeps one <details>;
  // only a narrow viewport turns it into an overlay, and the summary row stays
  // as the handle that opens and closes it.
  const css = await fs.readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  const mobile = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
  assert.ok(mobile, 'a phone-width block exists');
  const drawer = mobile[1].match(/\.controlsSpoiler\[open\]\s*\{([^}]*)\}/);
  assert.ok(drawer, 'the open session list is styled as an overlay');
  assert.match(drawer[1], /position:\s*fixed/, 'the drawer covers the page instead of pushing the chat down');
  assert.match(drawer[1], /inset:\s*0/);
  // The drawer itself has to be the scroller. Laid out as a flex column whose
  // body was sized by its content, it held 8000px of sessions inside an 844px
  // box and none of it could be scrolled: every session past the tenth was
  // unreachable from the phone (the drawer is the only way to them there).
  assert.match(drawer[1], /overflow-y:\s*auto/, 'the sessions scroll inside the drawer');
  assert.doesNotMatch(drawer[1], /display:\s*flex/, 'a flex column is what made the list unscrollable');
  const handle = mobile[1].match(/\.controlsSpoiler\[open\] > summary\s*\{([^}]*)\}/);
  assert.ok(handle, 'the handle has its own rule');
  assert.match(handle[1], /position:\s*sticky/, 'and stays reachable while the list scrolls');

  const { document } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  const spoiler = document.getElementById('controlsSpoiler');
  assert.ok(spoiler.querySelector(':scope > summary'), 'the summary handle is still the direct child');
  const body = spoiler.querySelector(':scope > .spoilerBody');
  assert.ok(body, 'the list and its controls share one body, which the drawer scrolls');
  assert.ok(body.contains(document.getElementById('tasks')), 'the sessions live in that body');
});
