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

// Uploads fingerprint what they store, and that function sits in the ingesting block - above
// the store, so it has to be spliced in or `addImage` throws on every call. `ingestFile`
// itself stays the stub passed to the factory: the real one needs a canvas.
const digesting = between(
  'async function digestOfIngested',
  '// ---------------------------------------------------------------- luminance',
);

const body = `${prelude}\n${persistence}\n${digesting}\n${store}
    return { getSnapshot, commit, patchSettings, boot, addImage, removeImage, subscribe, backfillDigests };`;

const record = (key) => ({ id: `img-${key}`, dataUrl: `data:${key}`, addedAt: 0 });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ ingest routing
// Which pipeline a picked file takes is decided by MIME type alone, and getting it wrong is
// silent in the worst possible way: send an animated GIF through the photo path and it comes
// out as a still JPEG. The picture is there, the gallery tile looks right, and the wallpaper
// just never moves. So the routing is sliced out and driven with stubs.
const ingestBody = [
  grab('const MAX_EDGE =', '\n'),
  grab('const MAX_DATA_URL =', '\n'),
  grab('const MAX_MEDIA_BYTES =', '\n'),
  grab('const POSTER_EDGE =', '\n'),
  between('// ---------------------------------------------------------------- ingesting', '// ---------------------------------------------------------------- luminance'),
  'return { ingestFile };',
].join('');

/** A decoder that always succeeds, at a fixed size. Enough to prove which branch ran. */
function makeIngest() {
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,POSTER',
  });
  const document = {
    createElement(tag) {
      if (tag === 'canvas') return canvas();
      const element = { videoWidth: 1920, videoHeight: 1080, muted: false, playsInline: false, preload: '' };
      Object.defineProperty(element, 'src', {
        set() {
          // `loadeddata` is the first moment there is a frame to draw, and the pipeline
          // deliberately waits for it rather than for `canplay`.
          setTimeout(() => { if (element.onloadeddata) element.onloadeddata(); }, 0);
        },
      });
      return element;
    },
  };
  const window = {
    URL: { createObjectURL: (blob) => `blob:${blob.name}`, revokeObjectURL() {} },
  };
  class FileReader {
    readAsDataURL() {
      setTimeout(() => { if (this.onload) this.onload({ result: 'data:image/png;base64,PICKED' }); }, 0);
    }
  }
  class Image {
    constructor() {
      this.width = 800;
      this.height = 600;
      this.onload = null;
      this.onerror = null;
    }
    set src(value) {
      this._src = value;
      setTimeout(() => { if (this.onload) this.onload(); }, 0);
    }
    get src() { return this._src; }
  }
  const factory = new Function('window', 'document', 'FileReader', 'Image', 'setTimeout', ingestBody);
  return factory(window, document, FileReader, Image, setTimeout);
}

const fileOf = (name, type, size) => ({ name, type, size: size === undefined ? 1024 : size });

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

function makeStore(win, initialImages, ingest) {
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
    // `put`, not `append`: the real store is keyed by `id`, so writing an existing record
    // replaces it. Backfilling fingerprints rewrites records that are already there, and a
    // push here would silently grow the gallery on every boot.
    async (item) => {
      const at = images.findIndex((existing) => existing.id === item.id);
      if (at < 0) images.push(item);
      else images[at] = item;
    },
    async (id) => {
      images = images.filter((item) => item.id !== id);
    },
    // The real `ingestFile` returns a record fragment now, not a bare data URL: the gallery
    // holds stills, GIFs and video alike, so the shape has to say which one it is. A caller
    // that needs to drive what gets ingested passes its own.
    ingest ||
      (async () => ({ kind: 'photo', dataUrl: 'data:new', poster: 'data:new', width: 0, height: 0 })),
  );
}

/**
 * The artwork on screen.
 *
 * `activeImage` used to *be* the data URL. It is a source record now — `{ kind, css, src,
 * poster, width, height }` — because a video wallpaper has no data URL at all. `src` is the
 * thing the source actually is: the data URL for a still, the object URL for a clip.
 */
const artOf = (snapshot) => (snapshot.activeImage === null ? null : snapshot.activeImage.src);

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
  check('selecting a picture paints it', artOf(snap()) === a.dataUrl, artOf(snap()));

  api.patchSettings({ imageId: b.id });
  check('switching again follows the click', artOf(snap()) === b.dataUrl, artOf(snap()));

  api.patchSettings({ imageId: c.id });
  check('and again', artOf(snap()) === c.dataUrl, artOf(snap()));

  api.patchSettings({ imageId: a.id });
  check('clicking an older picture repaints with it', artOf(snap()) === a.dataUrl, artOf(snap()));

  // -------------------------------------------------------------- the wallpaper stack
  // 换图不能改写正在显示的那个盒子：`background-image` 不是可动画属性，往可见元素上写新 URL
  // 是一帧换完的。所以新图另起一个盒子叠在上面淡入，下面的盒子一动不动。
  // 用独立实例，免得把上面那串「点击顺序」的历史带进来。
  const FADE_MS = Number((source.match(/const FADE_MS = (\d+);/) || [])[1] || 600);
  const MAX_WALLS = Number((source.match(/const MAX_WALLS = (\d+);/) || [])[1] || 6);
  const fade = makeStore(makeWindow(), [a, b, c]);
  fade.boot();
  await tick();
  const walls = () => (fade.getSnapshot().layer || { walls: [] }).walls;
  const top = () => walls().at(-1) || null;

  // A revision without the stack would throw on every line below instead of reporting. One
  // clear failure beats a stack trace.
  check('the store keeps a wallpaper stack', fade.getSnapshot().layer !== undefined, 'no `layer` in the snapshot');

  if (fade.getSnapshot().layer !== undefined) {
    fade.patchSettings({ mode: 'image', imageId: a.id });
    check(
      'the first picture goes up alone, with nothing to dissolve from',
      walls().length === 1 && walls()[0].value.includes('data:a'),
      JSON.stringify(walls()),
    );

    fade.patchSettings({ imageId: b.id });
    check(
      'switching leaves the old picture underneath',
      walls().length === 2 && walls()[0].value.includes('data:a'),
      JSON.stringify(walls()),
    );
    check(
      'and stacks the new one on top, where it can fade in',
      top().value.includes('data:b') && top().id !== walls()[0].id,
      JSON.stringify(top()),
    );

    fade.patchSettings({ blur: 3 });
    check('moving a slider does not stack a second fade', walls().length === 2, JSON.stringify(walls()));
    check('the slider lands on the picture on top', top().blur === 3, top().blur);
    check(
      'the picture underneath keeps the blur it was painted with',
      walls()[0].blur === 20,
      JSON.stringify(walls()[0]),
    );

    // The fade itself is CSS-side; what happens afterwards is this store's job. Wait it out,
    // with room for the settle timer's own margin.
    await new Promise((resolve) => setTimeout(resolve, FADE_MS + 250));
    check(
      'after the fade the stack is one picture again',
      walls().length === 1 && walls()[0].value.includes('data:b'),
      JSON.stringify(walls()),
    );

    fade.patchSettings({ imageId: c.id });
    check(
      'the next switch stacks on the survivor',
      walls().length === 2 && top().value.includes('data:c'),
      JSON.stringify(walls()),
    );

    // Clicking the picture that is already on top must not stack a duplicate of itself: that
    // box is at full opacity, so a second copy would fade from nothing to nothing - invisible,
    // but it would still keep the collapse timer alive and add a frame of work per click.
    fade.patchSettings({ imageId: c.id });
    check('re-selecting the picture on top adds nothing', walls().length === 2, JSON.stringify(walls()));

    fade.patchSettings({ mode: 'none' });
    check('turning the wallpaper off clears the stack', walls().length === 0, JSON.stringify(walls()));

    fade.patchSettings({ mode: 'image', imageId: a.id });
    check('turning it back on puts one picture up, with no fade', walls().length === 1, JSON.stringify(walls()));
  }

  // -------------------------------------------- clicking through the gallery in a burst
  // 连点时第三张不打断任何东西 —— 它只是又叠了一层。合成是可结合的，所以整摞仍然刚好盖满，
  // 最新的那张最终在上面。这是整个设计的要点：没有任何一步需要「停下来等」。
  const burst = makeStore(makeWindow(), [a, b, c]);
  burst.boot();
  await tick();
  const stackOf = () => (burst.getSnapshot().layer || { walls: [] }).walls;

  burst.patchSettings({ mode: 'image', imageId: a.id });
  burst.patchSettings({ imageId: b.id });
  check('a fade is in flight', stackOf().length === 2);

  burst.patchSettings({ imageId: c.id });
  check('the third picture stacks on top instead of replacing anything', stackOf().length === 3);
  check(
    'and nothing below it moved',
    stackOf()[0].value.includes('data:a') && stackOf()[1].value.includes('data:b'),
    JSON.stringify(stackOf().map((wall) => wall.value.slice(0, 24))),
  );

  burst.patchSettings({ mode: 'gradient', gradient: 0 });
  burst.patchSettings({ mode: 'gradient', gradient: 1 });
  check('a fourth and fifth click keep stacking', stackOf().length === 5, stackOf().length);

  // The guard is far enough out that a burst never reaches it, so push well past it on purpose:
  // the oldest has to be the one that goes, and the newest has to be the one left on top.
  for (let index = 0; index < MAX_WALLS; index += 1) burst.patchSettings({ mode: 'gradient', gradient: index % 3 });
  check(
    'the runaway guard drops the oldest and keeps the newest',
    stackOf().length === MAX_WALLS && stackOf().at(-1).value.includes('gradient'),
    `${stackOf().length} vs ${MAX_WALLS}`,
  );

  // The survivor has to be the box that was on top, not just any box - so the expectation is
  // taken from the stack itself rather than written out here.
  const lastPushed = stackOf().at(-1).value;
  await new Promise((resolve) => setTimeout(resolve, FADE_MS + 250));
  check(
    'a burst collapses to whatever was clicked last',
    stackOf().length === 1 && stackOf()[0].value === lastPushed,
    `${JSON.stringify(stackOf().map((wall) => wall.value.slice(0, 30)))} vs ${lastPushed.slice(0, 30)}`,
  );

  // A burst must not be able to starve the collapse: ten clicks forty milliseconds apart,
  // then nothing. The deadline is re-armed per box, so the last one always gets its full fade.
  const spam = makeStore(makeWindow(), [a, b, c]);
  spam.boot();
  await tick();
  spam.patchSettings({ mode: 'image', imageId: a.id });
  for (let index = 0; index < 10; index += 1) {
    spam.patchSettings({ imageId: index % 2 === 0 ? b.id : c.id });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const wanted = `url("${[a, b, c].find((item) => item.id === spam.getSnapshot().settings.imageId).dataUrl}")`;
  await new Promise((resolve) => setTimeout(resolve, FADE_MS + 400));
  const quiet = spam.getSnapshot().layer;
  check(
    'a burst drains on its own instead of starving the collapse',
    quiet.walls.length === 1,
    JSON.stringify(quiet.walls.length),
  );
  check(
    'and lands on the picture the pointer last touched',
    quiet.walls[0].value === wanted,
    `${quiet.walls[0].value.slice(0, 30)} vs ${wanted.slice(0, 30)}`,
  );

  // ------------------------------------------------------------------- framing
  // 取景位置跟模糊、压暗是同一类参数（跟着背景走），但它多一条契约：**上传新图不能继承上
  // 一张的偏移**。偏移是这张图的构图，换一张图还带着 12% 的横移，等于把新图裁在一个它从来
  // 没有过的构图上。
  const frameWin = makeWindow();
  const frame = makeStore(frameWin, [a, b, c]);
  frame.boot();
  await tick();
  const frameWalls = () => (frame.getSnapshot().layer || { walls: [] }).walls;

  frame.patchSettings({ mode: 'image', imageId: a.id });
  check(
    'a picture starts centred',
    frameWalls()[0].focusX === 50 && frameWalls()[0].focusY === 50,
    JSON.stringify(frameWalls()[0]),
  );
  frame.patchSettings({ focusX: 12, focusY: 88 });
  check(
    'dragging moves the picture that is on screen',
    frameWalls()[0].focusX === 12 && frameWalls()[0].focusY === 88,
    JSON.stringify(frameWalls()[0]),
  );
  // 这是同一条过渡里的同一张图，改的只是它被裁在哪里 —— 再叠一层会让拖动每动一下都淡一次。
  check('and does not stack a fade on top of itself', frameWalls().length === 1, `${frameWalls().length} walls`);
  check(
    'the offset is written under that picture',
    presetFor(frameWin, `image:${a.id}`).focusX === 12,
    JSON.stringify(presetFor(frameWin, `image:${a.id}`)),
  );

  frame.patchSettings({ imageId: b.id });
  check(
    'another picture has its own framing',
    frameWalls().at(-1).focusX === 50 && frameWalls().at(-1).focusY === 50,
    JSON.stringify(frameWalls().at(-1)),
  );
  frame.patchSettings({ imageId: a.id });
  check(
    'and coming back restores it',
    frameWalls().at(-1).focusX === 12 && frameWalls().at(-1).focusY === 88,
    JSON.stringify(frameWalls().at(-1)),
  );

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
  // Put a deliberate offset on the source that is on screen, so "the upload did not inherit
  // it" is a real observation rather than a coincidence of both being 50.
  api.patchSettings({ focusX: 18, focusY: 82 });
  await api.addImage({});
  const fresh = snap().images.at(-1);
  check('a fresh upload becomes the wallpaper', artOf(snap()) === 'data:new', artOf(snap()));
  check('a fresh upload inherits the look that is on screen', blurOf() === 7, blurOf());
  // 偏移和模糊不是一回事：模糊是「这个界面长什么样」，偏移是「这张图怎么裁」。继承一个
  // 12% 的横移等于把新图塞进它从来没有过的构图里。
  check(
    'but starts centred instead of inheriting the last framing',
    presetFor(win, `image:${fresh.id}`).focusX === 50 && presetFor(win, `image:${fresh.id}`).focusY === 50,
    JSON.stringify(presetFor(win, `image:${fresh.id}`)),
  );

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

  // ---------------------------------------------------------------- refusing duplicates
  // 同一个文件加第二次不该变成第二格。指纹按**存下来的那份**算 —— 照片存的是重编码后的
  // JPEG，不是原文件字节 —— 所以「同一张图选两次」在这里就等价于「两次 ingest 产物相同」。
  let pending = null;
  const dupWin = makeWindow();
  const dupApi = makeStore(dupWin, [], async () => pending);
  const dupSnap = () => dupApi.getSnapshot();
  const still = (dataUrl) => ({ kind: 'photo', dataUrl, poster: dataUrl, width: 0, height: 0 });

  pending = still('data:one');
  await dupApi.addImage({});
  check('the first upload lands in the gallery', dupSnap().images.length === 1, `${dupSnap().images.length}`);

  const keptId = dupSnap().images[0].id;
  // 先把壁纸切走，否则「切回这张」和「本来就停在这张」在屏幕上没有区别，测了也白测。
  dupApi.patchSettings({ mode: 'color', color: '#1b2233' });
  pending = still('data:one');
  let duplicate = null;
  try {
    await dupApi.addImage({});
  } catch (failure) {
    duplicate = failure && failure.message;
  }
  check('the same file a second time is refused', duplicate === 'duplicate', String(duplicate));
  check('and the gallery does not grow', dupSnap().images.length === 1, `${dupSnap().images.length}`);
  // 抛出去只是为了给调用方一个显示提示的理由。用户点「添加」的本意是「用这张图」，所以
  // 选中那张已有的必须真的发生 —— 否则提示「已经在图库里了」却什么都不做，看起来像上传失败。
  check(
    'and it switches to the copy that is already there',
    dupSnap().settings.imageId === keptId,
    String(dupSnap().settings.imageId),
  );
  check('and the wallpaper follows it', artOf(dupSnap()) === 'data:one', artOf(dupSnap()));

  pending = still('data:two');
  await dupApi.addImage({});
  check('a different picture still goes in', dupSnap().images.length === 2, `${dupSnap().images.length}`);

  // 老图库里的记录没有指纹，直接比就永远对不上 —— 这个功能对存量图片会整个失效，而且没有
  // 任何迹象。所以 boot 之后补算一遍写回去，测的是「补完之后存量图片也拦得住」。
  const legacyWin = makeWindow();
  const legacy = makeStore(
    legacyWin,
    [{ id: 'img-old', dataUrl: 'data:old', addedAt: 0 }],
    async () => still('data:old'),
  );
  legacy.boot();
  await tick();
  check(
    'a gallery saved before fingerprints existed has none',
    legacy.getSnapshot().images[0].digest === undefined,
    String(legacy.getSnapshot().images[0].digest),
  );
  await legacy.backfillDigests();
  check(
    'boot fills the gap in',
    typeof legacy.getSnapshot().images[0].digest === 'string',
    String(legacy.getSnapshot().images[0].digest),
  );
  // 幂等：已经有指纹的记录不该再算一遍，否则每次启动都要把所有大图重新哈希一次。
  const settled = JSON.stringify(legacy.getSnapshot().images);
  await legacy.backfillDigests();
  check('running it again changes nothing', JSON.stringify(legacy.getSnapshot().images) === settled);
  let legacyDuplicate = null;
  try {
    await legacy.addImage({});
  } catch (failure) {
    legacyDuplicate = failure && failure.message;
  }
  check('an old picture is refused too once it has a fingerprint', legacyDuplicate === 'duplicate', String(legacyDuplicate));
  check('and the old gallery is still one tile', legacy.getSnapshot().images.length === 1, `${legacy.getSnapshot().images.length}`);

  // ------------------------------------------------------------- deleting the active
  api.patchSettings({ mode: 'image', imageId: b.id });
  await api.removeImage(b.id);
  check(
    'deleting the active picture falls back to the tile that takes its place',
    artOf(snap()) === c.dataUrl,
    artOf(snap()),
  );
  check('deleting the active picture keeps the wallpaper on', snap().settings.mode === 'image', snap().settings.mode);
  check('the fallback is persisted, not just painted', win.stored(KEY).imageId === c.id, win.stored(KEY).imageId);

  await api.removeImage(a.id);
  check('deleting an inactive picture keeps the active one', artOf(snap()) === c.dataUrl, artOf(snap()));

  api.patchSettings({ dim: 42 });
  check('an unrelated setting keeps the wallpaper', artOf(snap()) === c.dataUrl, artOf(snap()));

  api.patchSettings({ blur: 17 });
  check('the surviving picture now has values of its own', blurOf() === 17, blurOf());

  // ------------------------------------------------------------------- a reload
  const reloaded = makeStore(win, [a, b, c]);
  reloaded.boot();
  await tick();
  check('the sliders survive a reload', reloaded.getSnapshot().settings.blur === 17, reloaded.getSnapshot().settings.blur);
  check('so do the global ones', reloaded.getSnapshot().settings.glassBlur === 12, reloaded.getSnapshot().settings.glassBlur);
  check('and the selection', artOf(reloaded.getSnapshot()) === c.dataUrl, artOf(reloaded.getSnapshot()));

  // ------------------------------------------------- migrating a flat v3 document
  const old = makeWindow();
  old.put(LEGACY, { mode: 'image', imageId: a.id, blur: 25, dim: 60, surface: 70, glassBlur: 8 });
  const migrated = makeStore(old, [a, b, c]);
  migrated.boot();
  await tick();
  check(
    'a v3 document still paints the same wallpaper',
    artOf(migrated.getSnapshot()) === a.dataUrl,
    artOf(migrated.getSnapshot()),
  );
  check('and keeps its sliders', migrated.getSnapshot().settings.blur === 25, migrated.getSnapshot().settings.blur);

  migrated.patchSettings({ imageId: b.id });
  check(
    'every other source starts from the migrated values, not the factory ones',
    migrated.getSnapshot().settings.blur === 25,
    migrated.getSnapshot().settings.blur,
  );
  check('including the panel density', migrated.getSnapshot().settings.surface === 70, migrated.getSnapshot().settings.surface);

  // ------------------------------------------------------------------ ingest routing
  const ingest = makeIngest();

  const photo = await ingest.ingestFile(fileOf('a.png', 'image/png'));
  check('a png takes the photo path', photo.kind === 'photo' && photo.blob === undefined, JSON.stringify(Object.keys(photo)));
  check('and is re-encoded to jpeg', String(photo.dataUrl).indexOf('data:image/jpeg') === 0, String(photo.dataUrl).slice(0, 22));
  check('and keeps the size it was decoded at', photo.width === 800 && photo.height === 600, `${photo.width}x${photo.height}`);

  // 这三条是「动图变静图」的唯一防线：走错分支不会报错，只会不动。
  for (const [type, label] of [['image/gif', 'gif'], ['image/webp', 'webp'], ['image/apng', 'apng']]) {
    const animated = await ingest.ingestFile(fileOf(`a.${label}`, type));
    check(
      `a ${label} keeps its own bytes`,
      animated.kind === 'animated' && animated.blob !== undefined,
      `${animated.kind} / ${String(animated.blob && animated.blob.name)}`,
    );
    check(`and carries a still frame for ${label}`, String(animated.poster).indexOf('data:image/jpeg') === 0, String(animated.poster).slice(0, 22));
  }

  for (const [type, label] of [['video/mp4', 'mp4'], ['video/webm', 'webm']]) {
    const clip = await ingest.ingestFile(fileOf(`a.${label}`, type));
    check(
      `a ${label} becomes a video`,
      clip.kind === 'video' && clip.blob !== undefined,
      `${clip.kind} / ${String(clip.blob && clip.blob.name)}`,
    );
    check(`and takes its size from the decoder for ${label}`, clip.width === 1920 && clip.height === 1080, `${clip.width}x${clip.height}`);
  }

  // The moving kinds are the only ones big enough to need a ceiling, and the check has to run
  // before the bytes are read - a 300 MB clip should not be decoded just to be rejected.
  let rejected = null;
  await ingest.ingestFile(fileOf('big.mp4', 'video/mp4', 300 * 1024 * 1024)).catch((failure) => { rejected = failure.message; });
  check('an oversized clip is refused before it is decoded', rejected === 'too-large-media', String(rejected));

  // A photo has its own, much smaller ceiling - it is re-encoded, not stored raw - so the
  // 96 MB gate must not be what stops it.
  const bigPhoto = await ingest.ingestFile(fileOf('big.png', 'image/png', 300 * 1024 * 1024));
  check('an oversized still is still re-encoded, not refused', bigPhoto.kind === 'photo', bigPhoto.kind);

  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
