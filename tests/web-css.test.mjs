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

test('an element hidden in the markup starts hidden in every mode', async () => {
  const { document } = parseHTML(await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  // The mode banner only ever gets text from startCloudMode(); in a local page it
  // must stay invisible.
  const banner = document.getElementById('modeBanner');
  assert.ok(banner, 'the cloud mode banner exists');
  assert.equal(banner.classList.contains('hidden'), true);
  assert.equal(banner.textContent.trim(), '');
});
