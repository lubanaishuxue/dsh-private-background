/**
 * Store-level regression test for the wallpaper gallery.
 *
 * The bug it exists for: uploading several pictures and then clicking an older one did
 * nothing — the wallpaper stayed on the newest upload. The cause was that `activeImage`
 * was a *stored copy* of `settings.imageId` and only `addImage()` ever wrote both.
 *
 * Rather than re-implementing the store (which would test the test), this slices the real
 * store block out of `client.js` and drives it with stubs. Point it at another revision to
 * see the failure:
 *
 *   git show v2.48.2:client.js > /tmp/old.js
 *   node tools/store-test.cjs /tmp/old.js
 */
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(file, 'utf8');

const START = '// -------------------------------------------------------------------- store';
const END = '// ------------------------------------------------------------------ selectors';
const from = source.indexOf(START);
const to = source.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.error(`could not find the store block in ${file}`);
  process.exit(1);
}
const body = source.slice(from, to);

// Guard against the slice silently becoming empty-ish if the file is restructured: without
// these markers the test would pass by testing nothing. They are deliberately the markers
// every revision has, so the same file can be pointed at an older one to watch it fail.
for (const marker of ['let state = {', 'function commit(', 'function patchSettings(', 'async function addImage', 'async function removeImage']) {
  if (!body.includes(marker)) {
    console.error(`store block is missing "${marker}" — the slice no longer covers the store`);
    process.exit(1);
  }
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const record = (key) => ({ id: `img-${key}`, dataUrl: `data:${key}`, addedAt: 0 });

function makeStore(initialImages, initialSettings) {
  let images = initialImages.slice();
  const writes = [];
  let settings = initialSettings;

  const factory = new Function(
    'readSettings',
    'writeSettings',
    'listImageRecords',
    'putImageRecord',
    'deleteImageRecord',
    'ingestFile',
    `${body}
    return { getSnapshot, commit, patchSettings, boot, addImage, removeImage, subscribe };`,
  );

  const api = factory(
    () => settings,
    (next) => {
      writes.push({ ...next });
      settings = { ...next };
    },
    async () => images.slice(),
    async (item) => {
      images.push(item);
    },
    async (id) => {
      images = images.filter((item) => item.id !== id);
    },
    async () => 'data:new',
  );

  return { api, writes, imagesNow: () => images };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  console.log(`store test: ${path.relative(process.cwd(), file)}`);

  const a = record('a');
  const b = record('b');
  const c = record('c');

  const { api, writes } = makeStore([a, b, c], { mode: 'image', imageId: a.id });
  const snap = () => api.getSnapshot();

  api.boot();
  await tick();
  check('boot picks the selected picture, not the newest', snap().activeImage === a.dataUrl, snap().activeImage);

  await api.addImage({});
  check('a fresh upload becomes the wallpaper', snap().activeImage === 'data:new', snap().activeImage);
  check(
    'a fresh upload is written to settings',
    writes.at(-1).mode === 'image' && /^img-\d+-/.test(String(writes.at(-1).imageId)),
    JSON.stringify(writes.at(-1)),
  );

  // ---- the regression -------------------------------------------------------------
  api.patchSettings({ imageId: a.id });
  check('clicking an older picture repaints with it', snap().activeImage === a.dataUrl, snap().activeImage);
  check('clicking an older picture persists the id', writes.at(-1).imageId === a.id, writes.at(-1).imageId);

  api.patchSettings({ imageId: b.id });
  check('switching again follows the click', snap().activeImage === b.dataUrl, snap().activeImage);

  api.patchSettings({ imageId: c.id });
  check('and again', snap().activeImage === c.dataUrl, snap().activeImage);

  // ---- deleting ------------------------------------------------------------------
  await api.removeImage(c.id);
  check('deleting the active picture leaves nothing to paint', snap().activeImage === null, snap().activeImage);
  check('deleting the active picture turns the wallpaper off', snap().settings.mode === 'none', snap().settings.mode);

  api.patchSettings({ mode: 'image', imageId: b.id });
  check('a surviving picture can still be selected', snap().activeImage === b.dataUrl, snap().activeImage);

  await api.removeImage(a.id);
  check('deleting an inactive picture keeps the active one', snap().activeImage === b.dataUrl, snap().activeImage);

  // ---- settings that are not about the gallery must not disturb it ----------------
  api.patchSettings({ dim: 42 });
  check('an unrelated setting keeps the wallpaper', snap().activeImage === b.dataUrl, snap().activeImage);
  check('an unrelated setting still gets persisted', writes.at(-1).dim === 42, writes.at(-1).dim);

  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
