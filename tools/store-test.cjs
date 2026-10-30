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
  grab('const FADE_MS =', '\n'),
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

  // -------------------------------------------------------------- the cross-fade stack
  // 换图不能改写正在显示的那个盒子：`background-image` 不是可动画属性，往可见元素上写新 URL
  // 是一帧换完的。新图必须叠在上面那个盒子里淡入，旧图原样留在下面。
  // 用独立实例，免得把上面那串「点击顺序」的历史带进来。
  const FADE_MS = Number((source.match(/const FADE_MS = (\d+);/) || [])[1] || 600);
  const fade = makeStore(makeWindow(), [a, b, c]);
  fade.boot();
  await tick();
  const slots = () => fade.getSnapshot().layer || { current: null, incoming: null };
  const has = (slot) => Boolean(slot) && typeof slot.value === 'string';

  // A revision without the stack would throw on every line below instead of reporting. One
  // clear failure beats a stack trace.
  check('the store keeps a two-deep wallpaper stack', fade.getSnapshot().layer !== undefined, 'no `layer` in the snapshot');

  if (fade.getSnapshot().layer !== undefined) {
    fade.patchSettings({ mode: 'image', imageId: a.id });
    const first = slots();
    check(
      'the first picture goes up in one frame, with nothing to dissolve from',
      has(first.current) && first.current.value.includes('data:a') && first.incoming === null,
      JSON.stringify(first),
    );

    fade.patchSettings({ imageId: b.id });
    const second = slots();
    check(
      'switching leaves the old picture underneath',
      has(second.current) && second.current.value.includes('data:a'),
      JSON.stringify(second.current),
    );
    check(
      'and stacks the new one on top, where it can fade in',
      has(second.incoming) && second.incoming.value.includes('data:b'),
      JSON.stringify(second.incoming),
    );

    fade.patchSettings({ blur: 3 });
    const third = slots();
    check(
      'moving a slider does not start a second fade',
      has(third.incoming) && third.incoming.value.includes('data:b'),
      JSON.stringify(third),
    );
    check('the slider lands on the picture coming in', third.incoming.blur === 3, third.incoming.blur);
    check(
      'the picture underneath keeps the blur it was painted with',
      third.current.blur === 20,
      JSON.stringify(third.current),
    );

    // The fade itself is CSS; what happens afterwards is this store's job. Wait it out, with
    // room for the settle timer's own margin.
    await new Promise((resolve) => setTimeout(resolve, FADE_MS + 250));
    const settled = slots();
    check(
      'after the fade the new picture is the one underneath',
      has(settled.current) && settled.current.value.includes('data:b'),
      JSON.stringify(settled),
    );
    check('and the top box is free again', settled.incoming === null, JSON.stringify(settled.incoming));

    fade.patchSettings({ imageId: c.id });
    check(
      'the next switch uses the free top box',
      has(slots().incoming) && slots().incoming.value.includes('data:c'),
      JSON.stringify(slots().incoming),
    );

    fade.patchSettings({ imageId: b.id });
    check(
      'going back to the picture underneath cancels the fade instead of stacking a third',
      slots().incoming === null && slots().current.value.includes('data:b'),
      JSON.stringify(slots()),
    );

    fade.patchSettings({ imageId: b.id });
    check('re-selecting the picture on screen changes nothing', slots().incoming === null);

    fade.patchSettings({ mode: 'none' });
    check(
      'turning the wallpaper off clears the stack',
      slots().current === null && slots().incoming === null,
      JSON.stringify(slots()),
    );
  }

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
