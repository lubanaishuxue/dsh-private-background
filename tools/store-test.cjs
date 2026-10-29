/**
 * Store-level regression test for the wallpaper gallery and the per-background sliders.
 *
 * Two contracts live here, both of which are easy to break without noticing:
 *
 * 1. The artwork on screen is a *function* of the gallery and the selected id. It used to be
 *    a stored copy, and clicking an older picture did nothing until a reload.
 * 2. Every background keeps its own set of sliders. Switching to another one must show that
 *    one's last values, and switching back must restore them.
 *
 * Rather than re-implementing the store (which would test the test), this slices the real
 * persistence + store blocks out of `client.js` and drives them with a fake localStorage.
 * Point it at another revision to see the failures:
 *
 *   git show v2.49.0:client.js > /tmp/old.js
 *   node tools/store-test.cjs /tmp/old.js
 */
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(file, 'utf8');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function die(message) {
  console.error(message);
  process.exit(1);
}

/** Cut the source between two section banners, keeping the start banner. */
function between(startMarker, endMarker) {
  const from = source.indexOf(startMarker);
  const to = source.indexOf(endMarker);
  if (from < 0) die(`could not find "${startMarker}" in ${file}`);
  if (to < 0) die(`could not find "${endMarker}" in ${file}`);
  if (to <= from) die(`"${startMarker}" comes after "${endMarker}" in ${file}`);
  return source.slice(from, to);
}

/** Cut one statement, from its opening token to the first closing marker. */
function grab(startMarker, endMarker) {
  const from = source.indexOf(startMarker);
  if (from < 0) die(`could not find "${startMarker}" in ${file}`);
  const to = source.indexOf(endMarker, from);
  if (to < 0) die(`could not find the end of "${startMarker}" in ${file}`);
  return source.slice(from, to + endMarker.length);
}

// The real constants and the real clamp, so a renamed key or a changed default shows up here
// instead of being quietly shadowed by a copy.
const prelude = [
  grab('const SETTINGS_KEY =', '\n'),
  grab('const LEGACY_SETTINGS_KEY =', '\n'),
  grab('const DEFAULTS = {', '\n    };\n'),
  grab('const GRADIENTS = [', '\n    ];\n'),
  grab('function clamp(', '\n    }\n'),
].join('');

const persistence = between(
  '// ---------------------------------------------------------------- persistence',
  '// -------------------------------------------------------------- image storage',
);

const store = between('// -------------------------------------------------------------------- store', '// ------------------------------------------------------------------ selectors');

// Without these markers the slice would be empty-ish and every assertion would pass by
// testing nothing. They are deliberately the markers every revision has, so the same file
// can be pointed at an older one to watch it fail.
for (const marker of ['let state =', 'function commit(', 'function patchSettings(', 'async function addImage', 'async function removeImage']) {
  if (!store.includes(marker)) die(`store block is missing "${marker}" — the slice no longer covers the store`);
}

// The per-source settings landed in v2.50.0. A revision before that has no `readRaw`, and
// running the assertions against it would fail with a stack trace instead of a verdict.
for (const marker of ['function readRaw(', 'function flatten(', 'function sourceKeyOf(', 'function applySettingsPatch(']) {
  if (!persistence.includes(marker) && !store.includes(marker)) {
    die(`missing "${marker}" — this revision predates per-background settings`);
  }
}

const body = `${prelude}\n${persistence}\n${store}
    return { getSnapshot, commit, patchSettings, boot, addImage, removeImage, subscribe };`;

const record = (key) => ({ id: `img-${key}`, dataUrl: `data:${key}`, addedAt: 0 });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A localStorage good enough for `readRaw` / `writeRaw`, plus a way to read it back. */
function makeWindow() {
  const cells = new Map();
  return {
    localStorage: {
      getItem: (key) => (cells.has(key) ? cells.get(key) : null),
      setItem: (key, value) => cells.set(key, String(value)),
      removeItem: (key) => cells.delete(key),
    },
    stored: (key) => {
      const text = cells.get(key);
      return text === undefined ? null : JSON.parse(text);
    },
    put: (key, value) => cells.set(key, typeof value === 'string' ? value : JSON.stringify(value)),
  };
}

function makeStore(win, initialImages) {
  let images = initialImages.slice();
  const factory = new Function(
    'window',
    'listImageRecords',
    'putImageRecord',
    'deleteImageRecord',
    'ingestFile',
    body,
  );
  return factory(
    win,
    async () => images.slice(),
    async (item) => {
      images.push(item);
    },
    async (id) => {
      images = images.filter((item) => item.id !== id);
    },
    async () => 'data:new',
  );
}

const KEY = 'dsh.custom-background.settings.v4';
const LEGACY = 'dsh.custom-background.settings.v3';
const presetFor = (win, key) => {
  const raw = win.stored(KEY);
  return raw === null || raw.presets === undefined ? undefined : raw.presets[key];
};

(async () => {
  console.log(`store test: ${path.relative(process.cwd(), file)}`);

  const a = record('a');
  const b = record('b');
  const c = record('c');

  // ---------------------------------------------------------------- the artwork
  const win = makeWindow();
  const api = makeStore(win, [a, b, c]);
  const snap = () => api.getSnapshot();

  api.boot();
  await tick();

  api.patchSettings({ mode: 'image', imageId: a.id });
  check('selecting a picture paints it', snap().activeImage === a.dataUrl, snap().activeImage);

  api.patchSettings({ imageId: b.id });
  check('switching again follows the click', snap().activeImage === b.dataUrl, snap().activeImage);

  api.patchSettings({ imageId: c.id });
  check('and again', snap().activeImage === c.dataUrl, snap().activeImage);

  api.patchSettings({ imageId: a.id });
  check('clicking an older picture repaints with it', snap().activeImage === a.dataUrl, snap().activeImage);

  // ------------------------------------------------------- one set of sliders each
  const blurOf = () => snap().settings.blur;

  check('a picture with no history starts at the factory values', blurOf() === 20, blurOf());

  api.patchSettings({ blur: 5, dim: 40 });
  check('the sliders follow the current picture', blurOf() === 5, blurOf());
  check(
    'and are written under that picture',
    presetFor(win, `image:${a.id}`).blur === 5,
    JSON.stringify(presetFor(win, `image:${a.id}`)),
  );

  api.patchSettings({ imageId: b.id });
  check('switching shows the other picture’s own values', blurOf() === 20, blurOf());

  api.patchSettings({ blur: 30 });
  api.patchSettings({ imageId: a.id });
  check('switching back restores what this picture had', blurOf() === 5, blurOf());
  check(
    'the two pictures did not overwrite each other',
    presetFor(win, `image:${b.id}`).blur === 30,
    JSON.stringify(presetFor(win, `image:${b.id}`)),
  );

  // ---------------------------------------------------------------- not per picture
  api.patchSettings({ glassBlur: 12, font: 'dark' });
  api.patchSettings({ imageId: b.id });
  check('glass blur is global, not per picture', snap().settings.glassBlur === 12, snap().settings.glassBlur);
  check('the typeface is global too', snap().settings.font === 'dark', snap().settings.font);

  // ------------------------------------------------------------ one set per colour
  api.patchSettings({ mode: 'color', color: '#1b2233' });
  api.patchSettings({ blur: 7 });
  api.patchSettings({ color: '#0d1117' });
  check('each colour is its own source', blurOf() === 20, blurOf());
  api.patchSettings({ color: '#1b2233' });
  check('switching back to a colour restores its own values', blurOf() === 7, blurOf());

  // ---------------------------------------------------------- one set per gradient
  api.patchSettings({ mode: 'gradient', gradient: 0 });
  api.patchSettings({ blur: 11 });
  api.patchSettings({ gradient: 1 });
  check('each gradient preset is its own source', blurOf() === 20, blurOf());
  api.patchSettings({ gradient: 0 });
  check('switching back to a gradient restores its own values', blurOf() === 11, blurOf());

  // -------------------------------------------------------------- "off" is a source
  api.patchSettings({ mode: 'none' });
  api.patchSettings({ blur: 33 });
  api.patchSettings({ mode: 'color', color: '#1b2233' });
  check('turning the wallpaper off does not disturb another source', blurOf() === 7, blurOf());
  api.patchSettings({ mode: 'none' });
  check('and the off state kept its own', blurOf() === 33, blurOf());

  // -------------------------------------------------------------- uploading, deleting
  api.patchSettings({ mode: 'color', color: '#1b2233' });
  await api.addImage({});
  const fresh = snap().images.at(-1);
  check('a fresh upload becomes the wallpaper', snap().activeImage === 'data:new', snap().activeImage);
  check('a fresh upload inherits the look that is on screen', blurOf() === 7, blurOf());

  api.patchSettings({ blur: 9 });
  api.patchSettings({ mode: 'color', color: '#1b2233' });
  check('the new picture has its own copy, not a shared one', blurOf() === 7, blurOf());

  await api.removeImage(fresh.id);
  check('deleting a picture drops its own values', presetFor(win, `image:${fresh.id}`) === undefined);
  check(
    'deleting it does not touch the surviving values',
    presetFor(win, 'color:#1b2233').blur === 7,
    JSON.stringify(presetFor(win, 'color:#1b2233')),
  );

  // ------------------------------------------------------------- deleting the active
  api.patchSettings({ mode: 'image', imageId: b.id });
  await api.removeImage(b.id);
  check(
    'deleting the active picture falls back to the tile that takes its place',
    snap().activeImage === c.dataUrl,
    snap().activeImage,
  );
  check('deleting the active picture keeps the wallpaper on', snap().settings.mode === 'image', snap().settings.mode);
  check('the fallback is persisted, not just painted', win.stored(KEY).imageId === c.id, win.stored(KEY).imageId);

  await api.removeImage(a.id);
  check('deleting an inactive picture keeps the active one', snap().activeImage === c.dataUrl, snap().activeImage);

  api.patchSettings({ dim: 42 });
  check('an unrelated setting keeps the wallpaper', snap().activeImage === c.dataUrl, snap().activeImage);

  api.patchSettings({ blur: 17 });
  check('the surviving picture now has values of its own', blurOf() === 17, blurOf());

  // ------------------------------------------------------------------- a reload
  const reloaded = makeStore(win, [a, b, c]);
  reloaded.boot();
  await tick();
  check('the sliders survive a reload', reloaded.getSnapshot().settings.blur === 17, reloaded.getSnapshot().settings.blur);
  check('so do the global ones', reloaded.getSnapshot().settings.glassBlur === 12, reloaded.getSnapshot().settings.glassBlur);
  check('and the selection', reloaded.getSnapshot().activeImage === c.dataUrl, reloaded.getSnapshot().activeImage);

  // ------------------------------------------------- migrating a flat v3 document
  const old = makeWindow();
  old.put(LEGACY, { mode: 'image', imageId: a.id, blur: 25, dim: 60, surface: 70, glassBlur: 8 });
  const migrated = makeStore(old, [a, b, c]);
  migrated.boot();
  await tick();
  check(
    'a v3 document still paints the same wallpaper',
    migrated.getSnapshot().activeImage === a.dataUrl,
    migrated.getSnapshot().activeImage,
  );
  check('and keeps its sliders', migrated.getSnapshot().settings.blur === 25, migrated.getSnapshot().settings.blur);

  migrated.patchSettings({ imageId: b.id });
  check(
    'every other source starts from the migrated values, not the factory ones',
    migrated.getSnapshot().settings.blur === 25,
    migrated.getSnapshot().settings.blur,
  );
  check('including the panel density', migrated.getSnapshot().settings.surface === 70, migrated.getSnapshot().settings.surface);

  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
