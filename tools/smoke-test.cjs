/**
 * Smoke test for the DSH custom-background client bundle (v2).
 *
 * Loads client.js inside a vm with a stubbed `window.__ModuleLoader__`, React, document,
 * localStorage and IndexedDB, then calls `apply(ctx)` exactly like the host does and
 * asserts on what the host would observe: one stylesheet in <head>, the activation
 * attribute on <html>, and the shape of the emitted CSS.
 *
 * Each scenario runs in a fresh sandbox, because the interesting behaviour is driven by
 * the settings - notably "work area only" versus "whole window", which is expressed by
 * whether the sidebar token is re-mixed at all.
 *
 * Usage:
 *   node tools/smoke-test.js ["D:/dsh-plugins/custom-background/client.js"] [--dump]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CLIENT = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : 'D:/dsh-plugins/custom-background/client.js',
);
const DUMP = process.argv.includes('--dump');
const CODE = fs.readFileSync(CLIENT, 'utf8');

const BASE_SETTINGS = {
  mode: 'gradient',
  gradient: 2,
  color: '#12324a',
  blur: 16,
  dim: 0,
  surface: 20,
  sidebarFill: 30,
  chatSurface: 78,
  composerSurface: 85,
  glassBlur: 14,
  menuFill: 30,
  menuBlur: 12,
  fullWindow: false,
  font: 'theme',
  fontColor: '#f7f8fa',
};

function makeElement(tag) {
  const el = {
    tagName: tag,
    dataset: {},
    attributes: {},
    style: {},
    _text: '',
    children: [],
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
    hasAttribute(name) { return name in el.attributes; },
    removeAttribute(name) { delete el.attributes[name]; },
    // `_parent` has to be recorded, otherwise `remove()` cannot take the node out of its
    // container and the tuning card would survive its own dispose.
    appendChild(child) { el.children.push(child); child._parent = el; return child; },
    remove() {
      const owner = el._parent;
      if (owner) {
        const index = owner.children.indexOf(el);
        if (index >= 0) owner.children.splice(index, 1);
      }
    },
    contains() { return false; },
    closest() { return null; },
    // One attribute selector is all `syncWalls` asks for, and it asks by id on purpose - see
    // the note there about never keying a box on its index.
    querySelector(selector) {
      const match = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
      if (match === null) return null;
      return el.children.find((child) => child.getAttribute(match[1]) === match[2]) || null;
    },
    // The fade is a Web Animation because a sheet rewrite would restart a CSS one. The stub
    // only has to record that something was asked to move.
    animate(keyframes, options) {
      const animation = { keyframes, options, cancelled: false, cancel() { animation.cancelled = true; } };
      if (el._animations === undefined) el._animations = [];
      el._animations.push(animation);
      return animation;
    },
    getAnimations() { return el._animations === undefined ? [] : el._animations.slice(); },
    // A video wallpaper is a real <video> child; `play()` is what starts it and it must not
    // throw when the browser refuses (autoplay policy), which is why the plugin swallows it.
    play() { return { catch() {} } },
    pause() {},
    // The tuning card is draggable, so it reads and writes real geometry. A fixed 248x320
    // box is enough for the clamp arithmetic to be checkable; anything more faithful would
    // be a layout engine.
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 248, bottom: 320, width: 248, height: 320, x: 0, y: 0 };
    },
    // Pointer capture is what lets a drag continue once the pointer leaves the header.
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() { return false; },
    // The tuning card is plain DOM, so it wires real listeners. Recording them lets a test
    // do what the user does - click the header, drag a slider - instead of only looking at
    // the tree it built.
    addEventListener(type, handler) {
      if (el._on === undefined) el._on = {};
      el._on[type] = handler;
    },
    removeEventListener(type) {
      if (el._on !== undefined) delete el._on[type];
    },
    // Pointer events need their own fields (clientX / pointerId), so the stub has to pass a
    // payload through rather than hand every handler the same shape.
    fire(type, props) {
      const handler = el._on === undefined ? undefined : el._on[type];
      if (handler !== undefined) handler({ target: el, ...(props === undefined ? {} : props) });
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(value) {
      el._text = String(value);
      // Real DOM semantics: assigning text replaces every child. `buildBody` relies on it.
      if (el._text === '') el.children.length = 0;
    },
  });
  return el;
}

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

/**
 * An IndexedDB just real enough for `openDb` + `dbRun`: `open()` succeeds on a timer, a
 * transaction hands back the seeded records, and `oncomplete` fires after the caller has had
 * a chance to attach it.
 */
function seededOpen(records) {
  const request = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
  request.result = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const transaction = { oncomplete: null, onerror: null, onabort: null };
      transaction.objectStore = () => ({
        getAll: () => {
          const read = { result: records.slice() };
          setTimeout(() => { if (transaction.oncomplete) transaction.oncomplete(); }, 0);
          return read;
        },
        put: (record) => { records.push(record); return { result: record }; },
        delete: () => ({}),
      });
      return transaction;
    },
  };
  setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
  return request;
}

/** One isolated plugin instance. Returns the CSS it emitted plus the DOM it touched. */
function harness(settingsOverride, extra) {
  const settings = { ...BASE_SETTINGS, ...settingsOverride };
  const seed = extra === undefined || extra.images === undefined ? null : extra.images;
  const reduced = extra !== undefined && extra.reducedMotion === true;
  const head = makeElement('head');
  const documentElement = makeElement('html');
  const body = makeElement('body');
  body._parent = documentElement;

  const store = new Map();
  store.set('dsh.custom-background.settings.v3', JSON.stringify(settings));

  const document = {
    documentElement,
    head,
    body,
    createElement: makeElement,
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      const match = /^style\[data-dshbg-(?:css|page)="(.+)"\]$/.exec(selector);
      if (match) {
        return head.children.find((el) => el.attributes['data-dshbg-css'] === match[1]) || null;
      }
      // The wallpaper boxes hang off <body>. Nothing else in the plugin is looked up from the
      // document root, so one extra case is enough.
      if (selector === 'body > [data-dshbg-stack]') {
        return body.children.find((el) => el.hasAttribute('data-dshbg-stack')) || null;
      }
      return null;
    },
    querySelectorAll() { return []; },
  };

  const windowListeners = {};
  const window = {
    // The card clamps its drag position against the viewport and listens for resize.
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, handler) { windowListeners[type] = handler; },
    removeEventListener(type) { delete windowListeners[type]; },
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); },
    },
    getComputedStyle() {
      // 真实的 CSSStyleDeclaration 既有属性也有 getPropertyValue；读自定义属性（--dshbg-*）
      // 只能走后者，所以桩子必须两个都提供。
      return {
        backgroundImage: 'none',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        backdropFilter: '',
        getPropertyValue: () => '',
      };
    },
    // A never-resolving open() keeps boot() pending, which is what the host looks like
    // before the first image read lands. The gallery tests need the read to land, so they
    // ask for a seeded store instead - the default path stays exactly as it was.
    indexedDB: seed === null ? { open() { return {}; } } : { open() { return seededOpen(seed); } },
    // `mediaUrlOf` mints one object URL per record per session. A blob stub with a name is
    // enough to tell two clips apart.
    URL: {
      createObjectURL: (blob) => `blob:${blob && blob.name ? blob.name : 'x'}`,
      revokeObjectURL() {},
    },
    // Reduced motion is honoured by not animating at all, and by showing a clip's poster
    // instead of playing it. Both branches read this.
    matchMedia: () => ({ matches: reduced }),
    setTimeout,
    clearTimeout,
  };

  const React = ReactStub;

  const registered = [];
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    slots: {
      inject(name, callback) { callback(); },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
  };

  class StubImage {
    constructor() { this.onload = null; this.onerror = null; }
    set src(value) { this._src = value; setTimeout(() => { if (this.onload) this.onload(); }, 0); }
    get src() { return this._src; }
  }

  let definition = null;
  window.__ModuleLoader__ = { load(def) { definition = def; } };

  const sandbox = {
    window,
    document,
    navigator: { language: 'zh-CN' },
    console,
    setTimeout,
    clearTimeout,
    FileReader: class {},
    Image: StubImage,
    indexedDB: window.indexedDB,
    React,
    // The title marquee wires observers up on mount. It never sees a crumb in this DOM
    // (querySelectorAll returns nothing), but constructing them exercises the real path.
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    // 跑马灯在 measure() 里读内边距，用的是裸 getComputedStyle（渲染进程里就是 window 上那个）。
    getComputedStyle: window.getComputedStyle,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'client.js' });

  return { definition, ctx, registered, documentElement, head, body, window, windowListeners, store };
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`);
  }
}

/** Apply the plugin with the given settings and return the emitted stylesheet. */
async function emit(settingsOverride, extra) {
  const run = harness(settingsOverride, extra);
  const { definition, ctx, registered, documentElement, head, body, window, windowListeners, store } = run;

  const exported = definition.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  exported.apply(ctx);

  // The auto-contrast measurement lands on a microtask; let it commit before reading.
  await new Promise((resolve) => setTimeout(resolve, 12));
  // A seeded gallery has to travel openDb -> transaction -> boot -> commit before the first
  // box exists, and that is more timer hops than a fixed wait is worth guessing at.
  if (extra !== undefined && extra.images !== undefined) {
    for (let waited = 0; waited < 800; waited += 10) {
      const host = body.children.find((el) => el.hasAttribute('data-dshbg-stack'));
      if (host !== undefined && host.children.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const tags = head.children.filter((el) => el.attributes['data-dshbg-css']);
  return {
    definition,
    exported,
    registered,
    documentElement,
    body,
    window,
    windowListeners,
    store,
    tags,
    css: tags.length > 0 ? tags[0].textContent : '',
  };
}

async function main() {
  const base = await emit({});
  console.log('module contract');
  check('module id matches package', base.definition && base.definition.id === '@local/dsh-custom-background');
  check('factory is a function', base.definition && typeof base.definition.factory === 'function');
  check('exports apply', typeof base.exported.apply === 'function');
  check('exports inject list', Array.isArray(base.exported.inject) && base.exported.inject.includes('slots'));

  console.log('\nside effects');
  check('exactly one stylesheet injected', base.tags.length === 1, `got ${base.tags.length}`);
  check('activation attribute set on <html>', base.documentElement.hasAttribute('data-dshbg-on'));
  check('css is non-empty', base.css.length > 500, `length ${base.css.length}`);

  console.log('\nwallpaper');
  const boxesOf = (run) => {
    const host = run.body.children.find((el) => el.hasAttribute('data-dshbg-stack'));
    return host === undefined ? [] : host.children;
  };
  // 壁纸是一个容器 + 每张图一个盒子。`::before`/`::after` 只有两个，做不了一次连点 —— 那需要
  // 无上限的层数，所以这里必须是真的元素。
  check('paints a container behind everything', base.css.includes('html[data-dshbg-on] [data-dshbg-stack]'));
  check('the container is a real element, not a pseudo-element', !base.css.includes('data-dshbg-on]::before'));
  check(
    'the container holds one absolutely positioned box per picture',
    /\[data-dshbg-stack\] > \[data-dshbg-wall\] \{[^}]*position: absolute;/.test(base.css),
    base.css.match(/\[data-dshbg-stack\] > \[data-dshbg-wall\] \{[^}]*\}/)?.[0],
  );
  // 稳态只有一张图、一个盒子，而且它不透明 —— 没有任何「空着的槽」需要维护。
  check('the steady state is one box', boxesOf(base).length === 1, `${boxesOf(base).length} boxes`);
  check(
    'and it carries the picture itself',
    String(boxesOf(base)[0].style.backgroundImage).includes('linear-gradient(135deg, #ff9a9e'),
    boxesOf(base)[0].style.backgroundImage,
  );
  check('with its own blur', boxesOf(base)[0].style.filter === 'blur(16px)', boxesOf(base)[0].style.filter);
  // 淡入本身（总不透明度不掉、换图只发生在盒子不可见时、底层恒为全不透明）由
  // tools/store-test.cjs 的状态机和 diag/burst-replica.html 的逐帧探针覆盖 —— 它们取决于动画
  // 进度，在假 DOM 里量不出来。这里钉住两件样式表能证明的事。
  check('the fade duration is a single constant', CODE.includes('const FADE_MS = 600;'));
  check(
    'the fade yields to prefers-reduced-motion',
    CODE.includes("matchMedia('(prefers-reduced-motion: reduce)')") &&
      /if \(walls\.length > 1 && !reducedMotion\(\)\)/.test(CODE),
  );
  // ⚠️ 淡入必须是 Web Animation，不能是 CSS `animation`/`transition`：`paint()` 每次改设置都
  // 重写整个 `<style>`，替换样式表文本会让表里定义的每条动画重启 —— 连点时会把它刚叠上去的
  // 盒子重置回 0。
  check(
    'the fade is attached to the box, not to the stylesheet',
    /\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\]/.test(CODE),
  );
  check(
    'and nothing in the sheet transitions the boxes',
    !/\[data-dshbg-wall\][^}]*transition:/.test(base.css),
  );
  // 压暗走 `brightness()` 而不是盖一层黑：黑层得压在整摞之上，而那上面没有元素可放。
  // 两条路径实测逐像素相同（最大差 2/255，8 位舍入），见 diag/brightness-equivalence.html。
  const dimmed = await emit({ dim: 15 });
  check(
    'the dim is a brightness filter, not a black sheet',
    boxesOf(dimmed)[0].style.filter === 'blur(16px) brightness(0.850)',
    boxesOf(dimmed)[0].style.filter,
  );
  check('no black sheet is painted over the wallpaper', !dimmed.css.includes('background-color: rgb(0 0 0 / 0.'));
  // 容器的几何必须走 vw/vh，不能走 inset。两者画出来的盒子一模一样，但对什么变化敏感
  // 完全相反：inset 相对视口解析，滚动条一出现整屏 filter 就得重做一次；vw/vh 相对初始
  // 包含块（含滚动条槽）解析，滚动条进出它不动。流式输出时正文列闪一帧就是这么来的。
  check(
    'the wallpaper box does not resize when a scrollbar comes and goes',
    /width: calc\(100vw \+ \d+px\)/.test(base.css) && /height: calc\(100vh \+ \d+px\)/.test(base.css),
  );
  check('the wallpaper box never uses inset', !/\[data-dshbg-stack\] \{[^}]*inset:/.test(base.css));
  check('the wallpaper blur is a cached layer', /will-change: filter/.test(base.css));
  check('clears html background', base.css.includes('html[data-dshbg-on] { background: transparent !important; }'));
  check('clears body background', base.css.includes('html[data-dshbg-on] body,'));

  // ------------------------------------------------------- moving pictures, framing
  // 三种来源画在同一套盒子里，但落地方式不同：照片是一张 JPEG，动图必须是原始字节（canvas
  // 往返会把它压成一帧），视频根本没有 CSS 属性可以播放 —— 只能塞一个真的 <video>。
  console.log('\nmoving pictures');
  const PHOTO = { id: 'img-photo', kind: 'photo', dataUrl: 'data:photo', poster: 'data:photo', width: 800, height: 600 };
  const CLIP = { id: 'img-clip', kind: 'video', blob: { name: 'clip' }, poster: 'data:clip-poster', width: 1920, height: 1080 };
  const GIF = { id: 'img-gif', kind: 'animated', blob: { name: 'gif' }, poster: 'data:gif-poster', width: 640, height: 360 };

  const photoRun = await emit({ mode: 'image', imageId: PHOTO.id }, { images: [PHOTO] });
  check('a photo is painted from its own data URL', boxesOf(photoRun)[0].style.backgroundImage === 'url("data:photo")', boxesOf(photoRun)[0].style.backgroundImage);
  check('and needs no element inside the box', boxesOf(photoRun)[0].children.length === 0);

  const clipRun = await emit({ mode: 'image', imageId: CLIP.id }, { images: [CLIP] });
  const clipBox = boxesOf(clipRun)[0];
  check('a video box carries a real <video>', clipBox.children.length === 1 && clipBox.children[0].tagName === 'video', JSON.stringify(clipBox.children.map((child) => child.tagName)));
  check('the still frame is written first, under it', clipBox.style.backgroundImage === 'url("data:clip-poster")', clipBox.style.backgroundImage);
  check('the clip itself is a blob URL', clipBox.children[0].getAttribute('data-src') === 'blob:clip', clipBox.children[0].getAttribute('data-src'));
  // 静音 + loop + autoplay + playsinline 四个一起才等于「当壁纸用」。少一个 muted 浏览器直接
  // 拒绝自动播放；少一个 playsinline 移动端会想全屏播放。
  // ⚠️ `muted` 还要**同时**写属性：这个 IDL 属性不反射到内容属性上，而自动播放策略读的是
  // 元素解析时的静音状态。只写 `.muted = true` 在真机上会静默变成「不播」。
  const clipVideo = clipBox.children[0];
  check(
    'and it is muted, looping, inline and told to start',
    clipVideo.muted === true && clipVideo.loop === true && clipVideo.autoplay === true &&
      clipVideo.hasAttribute('playsinline') && clipVideo.hasAttribute('muted'),
    JSON.stringify({ muted: clipVideo.muted, loop: clipVideo.loop, autoplay: clipVideo.autoplay, attributes: clipVideo.attributes }),
  );
  check('the box remembers what it is holding', clipBox.getAttribute('data-dshbg-media') === 'video', clipBox.getAttribute('data-dshbg-media'));
  check('the sheet sizes the video to the box', /\[data-dshbg-wall\] > video \{[^}]*object-fit: cover;/.test(base.css));

  const gifRun = await emit({ mode: 'image', imageId: GIF.id }, { images: [GIF] });
  const gifBox = boxesOf(gifRun)[0];
  // 动图走 background-image 就够：它自己会动，不需要元素。但必须写 blob URL 而不是 poster，
  // 否则「动图」只显示第一帧。
  check('an animated picture plays from its own bytes', gifBox.style.backgroundImage === 'url("blob:gif")', gifBox.style.backgroundImage);
  check('and needs no element of its own', gifBox.children.length === 0);

  // 减少动态效果时一律退回静帧：不是「动得快一点」，是根本不动。
  const calmRun = await emit({ mode: 'image', imageId: CLIP.id }, { images: [CLIP], reducedMotion: true });
  check('reduced motion shows the poster instead of playing', boxesOf(calmRun)[0].children.length === 0 && boxesOf(calmRun)[0].style.backgroundImage === 'url("data:clip-poster")', boxesOf(calmRun)[0].style.backgroundImage);

  console.log('\nframing');
  // 取景位置必须同时落到 background-position 和 object-position 上，否则同一张照片和同一段
  // 视频会按两套不同的构图显示。
  const framed = await emit({ mode: 'image', imageId: CLIP.id, focusX: 20, focusY: 70 }, { images: [CLIP] });
  const framedBox = boxesOf(framed)[0];
  check('the still is cropped from the chosen point', framedBox.style.backgroundPosition === '20% 70%', framedBox.style.backgroundPosition);
  check('and so is the clip, from the same point', framedBox.children[0].style.objectPosition === '20% 70%', framedBox.children[0].style.objectPosition);
  check('the framing is per background, not global', CODE.includes("'focusX',") && CODE.includes("'focusY',"));
  check('and it is clamped to the box', /focusX: clamp\(pick\('focusX'\), 0, 100\)/.test(CODE) && /focusY: clamp\(pick\('focusY'\), 0, 100\)/.test(CODE));

  console.log('\ntoken plumbing');
  check('captures the base surface', base.css.includes('--dshbg-raw-base: var(--dsw-alias-bg-base)'));
  check('captures the sidebar fill', base.css.includes('--dshbg-raw-sidebar: var(--dsw-specific-sidebar-fill)'));
  check('captures label tokens for the settings page', base.css.includes('--dshbg-raw-label-0: var(--dsw-alias-label-primary)'));
  check('re-mixes the base surface', base.css.includes('--dsw-alias-bg-base: color-mix'));
  // 宿主样式表里用得最多的那批背景 token，逐个都必须在重混列表里 —— 漏一个，那个面板就是
  // 一块孤立黑板（命令卡的输出体就是这么来的：它画 --dsw-alias-markdown-code-block）。
  check(
    'the host surface tokens are all remixed',
    [
      '--dsw-alias-markdown-code-block',
      '--dsw-alias-bg-module-platform',
      '--dsw-alias-settings-card-fill',
      '--dsw-specific-menu',
      '--dsw-alias-fill-l1',
      '--dsw-alias-fill-l2',
    ].every(
      (token) =>
        base.css.includes(`--dshbg-raw-`) &&
        new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: color-mix`).test(base.css),
    ),
  );
  check('keeps elevation order', /--dsw-alias-bg-layer-2: color-mix\(in srgb, var\(--dshbg-raw-l2\) 36%/.test(base.css));
  check('targets the frame structurally', base.css.includes('#root div:has(> [data-shell-overlay])'));

  // The core requirement: by default the conversation sidebar must be left alone. That
  // is expressed by *not* re-mixing its token - no override rule needed.
  console.log('\nscope: work area only (default)');
  check('sidebar token is NOT re-mixed', !base.css.includes('--dsw-specific-sidebar-fill: color-mix'));
  check('sidebar token is still captured', base.css.includes('--dshbg-raw-sidebar:'));
  check('bottom bar kept on the theme base colour', base.css.includes('[data-shell-bottom] { background-color: var(--dshbg-raw-base) !important; }'));

  const wide = await emit({ fullWindow: true });
  console.log('\nscope: whole window');
  check('sidebar token IS re-mixed', wide.css.includes('--dsw-specific-sidebar-fill: color-mix'));
  check('bottom bar left glassy', !wide.css.includes('[data-shell-bottom] {'));

  console.log('\nconversation opacity');
  // The transcript needs a steadier backdrop than the chrome. It overrides the base token
  // on the center column rather than stacking a second translucent layer, because two
  // layers compose to an opacity neither slider describes.
  const chatRule = /html\[data-dshbg-on\][^{},]*> div:nth-of-type\(2\)\s*\{([^}]*)\}/.exec(base.css);
  check('center column gets its own base token', chatRule !== null);
  if (chatRule !== null) {
    check('uses the conversation value, not the panel one', chatRule[1].includes('var(--dshbg-raw-base) 78%'), chatRule[1].trim().slice(0, 80));
    check('override carries !important', /!important/.test(chatRule[1]));
  }
  // The frame-level remix must lose to it, so the conversation rule has to be a strict
  // descendant of the same frame selector - one extra element and one extra pseudo-class.
  const frameRule = /html\[data-dshbg-on\] #root div:has\(> \[data-shell-overlay\]\)\s*\{/.test(base.css);
  check('frame-level remix still present underneath', frameRule);
  check('conversation rule is the stricter selector', chatRule !== null && chatRule[0].includes('> div:nth-of-type(2)'));
  const chatLow = await emit({ chatSurface: 12 });
  check('conversation opacity moves independently', chatLow.css.includes('var(--dshbg-raw-base) 12%') && chatLow.css.includes('var(--dshbg-raw-base) 20%'));

  console.log('\ncomposer opacity');
  // [data-composer-card] is the element that paints the message box, so overriding the
  // input token on it covers the fill without a second background rule.
  const composerRule = /html\[data-dshbg-on\] \[data-composer-card\]\s*\{([^}]*)\}/.exec(base.css);
  check('message box gets its own input token', composerRule !== null);
  if (composerRule !== null) {
    check('uses the composer value, not the panel one', composerRule[1].includes('var(--dshbg-raw-input) 85%'), composerRule[1].trim().slice(0, 80));
    check('composer override carries !important', /!important/.test(composerRule[1]));
  }
  const composerLow = await emit({ composerSurface: 30 });
  check('composer opacity moves independently', composerLow.css.includes('var(--dshbg-raw-input) 30%'));
  check('panel input token still at its own value', composerLow.css.includes('var(--dshbg-raw-input) 28%'));

  console.log('\nliquid glass');
  const glass = await emit({ composerStyle: 'glass' });
  check('message box becomes a pane', glass.css.includes('[data-composer-card]'));
  check('attachment chips become panes', glass.css.includes('[class*="_fileCard"]'));
  // 交付卡片画的是 --deliverable-fill（静态中性色），token 重混够不到它，只能整块铺玻璃。
  // 只认 _file 会误伤 24px 的输入框附件片和变更文件行，所以要求它自带 _fileBody 子节点。
  check('deliverable cards are found by their data attribute', glass.css.includes('[data-presented-file]'));
  check(
    'deliverable cards keep a class fallback',
    glass.css.includes('[class$="_file"]:has(> [class$="_fileBody"])'),
  );
  check('code block wrapper found by stable half of its class', glass.css.includes('[class*="_block_"]:has([data-code-block-banner])'));
  // 内联 code 画的是 --dsw-alias-markdown-inline-code，不在重混列表里，一直是实色芯片。
  // `_markdown_` 后面那个下划线很关键：它把 _markdownPreview 挡在外面。
  check('inline code becomes a chip', glass.css.includes('[class*="_markdown_"] :not(pre) > code'));
  // 芯片只有 20px 高，22% 的填充会糊进壁纸，等宽字体那一串就不再像一个 token。
  check('inline code chip is filled heavier than a pane', glass.css.includes('var(--dshbg-raw-base) 45%'));
  check('inline code chip drops the drop shadow', !/\[class\*="_markdown_"\] :not\(pre\) > code \{[^}]*0 10px 30px/.test(glass.css));
  check('blur comes from the glass slider', glass.css.includes('blur(14px) saturate(160%)'));
  check('edge highlight is present', glass.css.includes('inset 0 1px 0 0 rgb(255 255 255 / 0.10)'));
  // The `pre` and the `_banner` row paint the block's own colour on top; without clearing
  // them the pane is only frosted around an opaque core.
  check('code block pre is cleared', /\[class\*="_block_"\]\:has\(\[data-code-block-banner\]\) pre/.test(glass.css));
  check(
    'the banner row itself is cleared',
    /\[class\*="_banner"\],[\s\S]{0,300}?\{\s*background: transparent !important/.test(glass.css),
  );
  // 表头是**盖子**，不是窗口：宿主给它 `position: sticky; top: 0`，代码会从它下面滑过去。
  // 它借的是**对话框的材料**（composerSurface + menuBlur），不自己另立一套数字 ——
  // 这样两处玻璃不会分家，用户调一次两个一起动。
  //
  // 真正遮住代码的是**模糊**不是填充：50% 时文字仍然清晰，`blur(50px)` 才让它消失。
  // 所以「填充要多黑」这个问法本身是错的，别再去调一个更大的填充值。
  const bannerRule = (css) => {
    const fill = css.match(
      /\[class\*="_bannerWrap"\] \{\s*background-color: color-mix\(in srgb, var\(--dshbg-raw-base\) (\d+)%/,
    );
    const blur = css.match(/\[class\*="_bannerWrap"\] \{[\s\S]{0,600}?backdrop-filter: blur\((\d+)px\)/);
    return { fill: Number(fill && fill[1]), blur: Number(blur && blur[1]) };
  };
  const bannerDefault = bannerRule(glass.css);
  check('the banner stays a lid, not a window', bannerDefault.fill > 0 && bannerDefault.blur > 0);
  // 真正的性质是「跟对话框是同一个值」，不是「等于某个数字」—— 所以从同一张样式表里
  // 把对话框自己的两个值读出来比对。写死 50/50 的话，用户一调滑杆这条就失去意义了。
  const composerFill = Number(
    (glass.css.match(
      /\[data-composer-card\] \{\s*position: relative !important;\s*background-color: color-mix\(in srgb, var\(--dshbg-raw-base\) (\d+)%/,
    ) || [])[1],
  );
  const composerBlur = Number(
    (glass.css.match(/\[data-composer-card\] \{[\s\S]{0,600}?backdrop-filter: blur\((\d+)px\)/) || [])[1],
  );
  check('the banner reads the composer fill', composerFill > 0 && bannerDefault.fill === composerFill);
  check('the banner reads the composer blur', composerBlur > 0 && bannerDefault.blur === composerBlur);
  const bannerTuned = bannerRule(
    (await emit({ composerStyle: 'glass', composerSurface: 72, menuBlur: 24 })).css,
  );
  check(
    'the banner follows those sliders instead of a constant',
    bannerTuned.fill === 72 && bannerTuned.blur === 24,
  );
  check(
    'the banner is never left transparent',
    !/\[class\*="_bannerWrap"\][^}]{0,200}?background: transparent/.test(glass.css),
  );
  // 表头不在的时候（无语言围栏、流式未完成、轨迹与预览渲染器）`:has()` 那半不匹配，
  // 代码块就一点底色都没有、把壁纸直接透出来 —— 所以 `.md-code-block` 必须单独兜一层。
  // 测的是「那条规则里有玻璃填充」，不是「它在列表的第几个位置」—— `.md-code-block`
  // 从逗号列表中间挪到单独一条规则时，位置变了但性质没变。
  const mdBlockRule = glass.css.match(/html\[data-dshbg-on\] \.md-code-block[^{]*\{([\s\S]{0,900}?)\}/);
  check(
    'banner-less code blocks still get the glass',
    !!mdBlockRule && mdBlockRule[1].includes('background-color: color-mix'),
  );
  // Two competing routes to the same surface would fight; glass paints directly.
  // The frame-level remix still emits the token, so assert on the card rule specifically.
  check('solid token route dropped in glass mode', !/\[data-composer-card\]\s*\{[^}]*--dsw-specific-input-major/.test(glass.css));
  check('every glass selector is prefixed', !/(^|\})\s*(?:\[|div)/.test(glass.css));
  const glassLow = await emit({ composerStyle: 'glass', glassBlur: 3 });
  check('glass blur is adjustable', glassLow.css.includes('blur(3px) saturate(160%)'));

  // 转写区的表面是内容、不是外壳：输入框切回实心是「输入框」的决定，不该连带把所有
  // 代码块和文件卡也拉回实色。所以这两类与输入框的开关解耦，常开。
  check('solid mode leaves the message box flat', !/\[data-composer-card\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  // ⭐ v2.47.0：这些表面**不许**再自带 backdrop-filter。
  //
  // 它们底下只有「已经在 `html::before` 糊过的壁纸」，所以自带一份等于花一次全尺寸
  // backdrop 快照去糊一张已经糊了的图 —— 视觉上买不到东西，代价却是每帧一次。而
  // Chromium 给每个 backdrop-filter 元素按它的 backdrop root 开一张 surface，某帧这张
  // surface 没就绪就是**整片空白**：流式输出时正文列每帧重绘，快照每帧重拍，输掉的那
  // 一帧整列只剩壁纸，而左栏没在重绘所以完好。这就是那个闪。
  //
  // 断言测的是「规则体里没有 backdrop-filter」，不是「某处有 backdrop-filter」—— 旧的
  // 五条正好相反，它们把 bug 保护了整整五轮。
  const ruleBody = (css, selector) => {
    const at = css.indexOf(selector);
    if (at < 0) return null;
    const open = css.indexOf('{', at);
    if (open < 0) return null;
    const close = css.indexOf('}', open);
    if (close < 0) return null;
    return css.slice(open, close);
  };
  for (const selector of [
    '[class*="_fileCard"]',
    '[class*="_block_"]',
    '[class*="_markdown_"]',
    '[data-changed-files]',
    '[data-chat-flow-kind="user"] [class*="_bubble"]',
  ]) {
    const body = ruleBody(base.css, selector);
    check(
      `no backdrop filter on ${selector}`,
      body !== null && !body.includes('backdrop-filter'),
      body === null ? 'rule missing' : body.slice(0, 80),
    );
  }
  // 描边一律用 inset 阴影，**不许用真的 border**。
  // 宿主没给这些盒子写 box-sizing: border-box（侧栏的行是 content-box），所以加 1px
  // border 会把盒子撑宽 2px。在内容列里 2px 就是一条横向滚动条，而横向滚动条一出现
  // 又会让竖向滚动条的高度预算变化 —— 两条滚动条互相喂饭，就是你看到的「两个东西
  // 各自在闪、节奏还错开」。这条断言是全局的：配方里一次 border 都不许有。
  check('no pane grows itself with a real border', !/border: 1px solid/.test(base.css));
  // ⭐ v2.48.1：代码块必须自己裁圆角。
  //
  // 表头是 sticky 的盖子，滑到最远时下沿压在外壳下沿上；表头下角是直角、外壳下角是圆角，
  // 而外壳不裁子元素 → 表头的填充铺到圆角外面，下两角变方角。修法是让外壳裁。
  //
  // ⚠️ **`clip` 和 `hidden` 不能换。** `hidden` 会建立滚动容器，sticky 的参照物变成它
  // 自己（而它不滚动）→ 表头彻底不粘。`clip` 不建滚动容器，只按圆角裁。
  // 所以这里测的是两件事：一定要 clip，一定不能是 hidden/auto/scroll。
  const blockBody = String(ruleBody(base.css, '[class*="_block_"]'));
  check(
    'the code block clips its own rounded corners',
    blockBody.includes('overflow: clip'),
    blockBody.slice(0, 120),
  );
  check(
    'the code block never becomes a scroll container',
    !/overflow:\s*(hidden|auto|scroll)/.test(blockBody),
  );
  // 圆角**只由外壳的 `overflow: clip` 给**，表头一个角都不要自己声明（v2.48.2）。
  //
  // 表头是 `sticky; top: 0`。它自带圆角时，一旦吸在视口顶上，外壳的圆角已经滚出屏幕，
  // 表头的圆角还在 —— 那两个弧挖出的缺口里露出外壳（方角）的填充，就是用户说的
  // 「文本框什么也不干，在表头的左上右上会出现文本框的直角」。
  //
  // 所以这里测的是**性质**：表头那几条规则里不许出现非零的 `border-*-radius`。
  // 不许写 `!includes('border-radius')` —— 现在我们是主动把它写成 0，那条会假绿。
  const bannerRuleBodies = (css) => {
    const out = [];
    let at = css.indexOf('[class*="_banner"]');
    while (at >= 0) {
      const open = css.indexOf('{', at);
      const close = css.indexOf('}', open);
      if (open < 0 || close < 0) break;
      out.push(css.slice(open, close));
      at = css.indexOf('[class*="_banner"]', close);
    }
    return out;
  };
  const bannerRadiusDecls = bannerRuleBodies(base.css).flatMap((body) =>
    [...body.matchAll(/border(?:-(?:top|bottom))?(?:-(?:left|right))?-radius:\s*([^;!]+)/g)].map((m) => m[1].trim()),
  );
  check(
    'the banner never rounds a corner of its own',
    bannerRadiusDecls.every((value) => /^0(?:px)?$/.test(value)),
    bannerRadiusDecls.join(' | '),
  );
  check(
    'the banner explicitly flattens its top corners',
    /\[class\*="_banner"\][^{]*\{[\s\S]{0,200}?border-top-left-radius: 0 !important/.test(base.css),
  );
  check('the pane ring is an inset shadow', /inset 0 0 0 1px color-mix\(in srgb, var\(--dshbg-raw-label-0\) 16%/.test(base.css));
  // 诊断开关 v2.48.0 从界面摘掉，管道 v2.49.0 一起删了（见 ENGINEERING.md #22）。三件事都测：
  // 样式表里不许再出现那两个属性名、源码里不许再有 `flatCss`。留下任何一个，都说明
  // 有代码还在往样式表里写一段永远不会生效的规则。
  check(
    'the retired diagnostic plumbing is gone',
    !base.css.includes('data-dshbg-flat') && !base.css.includes('data-dshbg-noblur') && !CODE.includes('flatCss'),
  );
  // 用户消息气泡画 --dsw-specific-bubble，同样不在重混列表里。它属于转写区内容，
  // 所以跟着文件卡/代码块一起常开，而不是跟输入框的开关。
  check('user bubble becomes a pane', base.css.includes('[data-chat-flow-kind="user"] [class*="_bubble"]'));
  // 会话里只有第一条用户消息是 flow-kind="user"；中途追加的提示词是 `steering`，排队跟进的
  // 是 `turn-trigger`。只认 user 就会得到「只有第一句有玻璃」。
  check(
    'follow-up prompts get the same bubble glass',
    base.css.includes('[data-chat-flow-kind="steering"] [class*="_bubble"]') &&
      base.css.includes('[data-chat-flow-kind="turn-trigger"] [class*="_bubble"]') &&
      base.css.includes('[class*="_userRow"] [class*="_bubble"]'),
  );
  // 气泡是用户消息，走常规 pane 配方（用户明确要求别单独给它加重填充）。
  check('user bubble is back on the pane recipe', /\[class\*="_bubble"\][^{]*\{[^}]*22%/.test(base.css));
  // 代码块有三处各自画底色：_block 和 pre 画 --dsl-code-block-background，
  // _banner 画 --dsl-code-block-banner-background-color。早先只清了 _bannerWrap，
  // 于是标题栏那条「代码块」一直是实心深色。
  check('code block drops the host fill through its own variable', base.css.includes('--dsl-code-block-background: transparent'));
  check('code block banner drops its fill too', base.css.includes('--dsl-code-block-banner-background-color: transparent'));
  check('code block banner is cleared directly as well', base.css.includes('[class*="_banner"]'));
  // 转写区右侧那排标记的悬停预览卡画 --dsw-alias-bg-layer-1，那个 token 在重混列表里，
  // 卡片于是掉到 28% 透明，背后的正文直接穿过来，两边都没法读。v2.16 的修法是把卡片钉回
  // 不透明 —— 读是能读了，但整窗只剩这一块实心黑方块，用户一眼就挑出来了。现在是玻璃：
  // 共享两条临时滑块的填充和模糊，但填充有 50% 硬下限（它压在正文上，不是贴在壁纸上）。
  check(
    'preview card becomes glass',
    /\[class\*="_preview"\]:has\(\[class\*="_previewResponse"\]\) \{[^}]*color-mix\(in srgb, var\(--dshbg-raw-l1\) (\d{1,3})%, transparent\)[\s\S]{0,200}?backdrop-filter: blur\((\d{1,2})px\)/.test(
      base.css,
    ),
  );
  // 别再钉回不透明：这条会拦住「把整条规则删回 var(--dshbg-raw-l1)」那种回滚。
  check(
    'preview card no longer pins an opaque fill',
    !/\[class\*="_preview"\]:has\(\[class\*="_previewResponse"\]\) \{[^}]*background: var\(--dshbg-raw-l1\) !important/.test(
      base.css,
    ),
  );
  // 填充下限：滑块拉到 20% 时，预览卡仍然是 50%（12px 小字压在正文上，不能更透）。
  {
    const dim = await emit({ menuFill: 20 });
    check(
      'preview card keeps a legibility floor',
      /\[class\*="_preview"\]:has\(\[class\*="_previewResponse"\]\) \{[^}]*var\(--dshbg-raw-l1\) 50%,/.test(
        dim.css,
      ),
    );
  }
  // 菜单的玻璃画在**表面**（[data-menu-material]）上，不画在 _material 子元素上。
  // 理由是两个朴素的：材料层是 z-index:-1，宿主只要给表面加一点背景就把它盖住；
  // 而且一层同时出 fill 和 blur 就少一个合成层。
  //
  // 注意这里**不是**修复「模糊不生效」的地方 —— 真凶在祖先（见下面 composer card 那条）。
  // 曾经怀疑是表面那句 isolation: isolate 把子元素围死了，但拿同样结构的对照页实测，
  // Chromium 并不会因为 isolation 就隔离 backdrop 采样，所以这个假设是错的，别再写回去。
  check(
    'menu surface paints its own glass',
    /\[data-menu-material\] \{[^}]*color-mix\(in srgb, var\(--dshbg-raw-l1\) (\d{1,3})%, transparent\)[\s\S]{0,300}?backdrop-filter: blur\((\d{1,2})px\) saturate\(150%\)/.test(
      base.css,
    ),
  );
  // 材料层彻底让位：不画底色、也不画模糊。两层都画会叠成 1-(1-f)²，而且子元素那层
  // 本来就被 isolation 隔离，留着只是白建一个合成层。
  check(
    'menu material layer stands down',
    /\[data-menu-material\] > \[class\*="_material"\] \{[^}]*background: transparent[\s\S]{0,200}?backdrop-filter: none/.test(
      base.css,
    ),
  );
  // `/` 命令菜单（.Z9Jnlq_menu）自己既没有底色、也没有 backdrop-filter —— 规则里只有
  // max-height / box-shadow / padding / position / overflow:hidden。所以底色和模糊都得插件给。
  check(
    'composer command menu carries its own fill and blur',
    /\[class\*="_menu"\]:has\(\[class\*="_itemDescription"\]\)[\s\S]{0,60}?\{[^}]*color-mix\(in srgb, var\(--dshbg-raw-l1\) (\d{1,3})%, transparent\)[\s\S]{0,300}?backdrop-filter: blur\((\d{1,2})px\)/.test(
      base.css,
    ),
  );
  // 输入框卡片：模糊画在卡片**自己身上**，菜单的冲突交给状态裁决。
  //
  // 历史：先是「模糊挂 ::before + isolation」（填充渲染、模糊从没上屏），再是「::before +
  // z-index: 0」（同样没上屏）。现在用转录区卡片验证过的那条路——元素自带 backdrop-filter——
  // 并用 installComposerMenuGuard 在 `/` 菜单打开期间把卡片的模糊让出去，菜单才拿回自己的。
  //
  // 这条必须在「质感 = 液态玻璃」下测：实心模式压根不给卡片套玻璃配方。
  const glassy = await emit({ composerStyle: 'glass' });
  check(
    'composer card paints its own frost',
    /\[data-composer-card\] \{[^}]*var\(--dshbg-raw-base\) 85%[\s\S]{0,400}?backdrop-filter: blur\(12px\) saturate\(160%\)/.test(
      glassy.css,
    ),
  );
  check(
    'composer density comes from its own slider',
    (await emit({ composerStyle: 'glass', composerSurface: 40 })).css.includes('var(--dshbg-raw-base) 40%, transparent'),
  );
  check(
    'composer hands its blur to the menu while a menu is open',
    /html\[data-dshbg-on\]\[data-dshbg-menu\] \[data-composer-card\] \{[^}]*backdrop-filter: none/.test(
      glassy.css,
    ),
  );
  check(
    'the menu guard watches for a menu inside the composer',
    CODE.includes("document.querySelector('[data-composer-card] [data-menu-material]')"),
  );
  check(
    'composer no longer depends on a pseudo-element',
    !/\[data-composer-card\]::before/.test(glassy.css),
  );
  // 右侧侧边栏：玻璃铺在 panel 根上（它自己本来一点底色都没有，可见的面在更下层），
  // 下面几层 dockkit 必须停止画底色，否则盖住玻璃。
  // 必须**只在打开时**画。panel 根是常驻的：收起时它照样占着那一列的宽度，只是把内容
  // translateX + visibility:hidden 藏起来。无条件铺底色 = 侧栏没开也糊一大块盖住对话。
  check(
    'right sidebar gets the same glass while open',
    /\[data-sidebar-right-panel\]\[data-sidebar-right-open\] \{[^}]*color-mix\(in srgb, var\(--dshbg-raw-l1\) (\d{1,3})%, transparent\)[\s\S]{0,300}?backdrop-filter: blur\((\d{1,2})px\) saturate\(150%\)/.test(
      base.css,
    ),
  );
  check(
    'right sidebar glass is gated on open',
    !/\[data-sidebar-right-panel\] \{/.test(base.css),
  );
  check(
    'right sidebar inner layers stop painting',
    /\[data-sidebar-right-panel\] \[data-dockkit-pane\][\s\S]{0,200}?\{[^}]*background-color: transparent/.test(
      base.css,
    ),
  );

  // 这个比例已经固化进 DEFAULTS.menuFill（30），所以上面几条只校验「有填充、带百分号」。
  // 这条单独校验 menuSurfaceCss 真的读的是 settings —— 意义在于：如果谁把它改回写死字面量，
  // 上面几条照样会过（因为固化值恰好等于那个数），只有这条会炸。
  const menu88 = await emit({ menuFill: 88 });
  check(
    'menu fill follows the setting, not a literal',
    menu88.css.includes('var(--dshbg-raw-l1) 88%, transparent') &&
      !menu88.css.includes('var(--dshbg-raw-l1) 76%, transparent'),
  );
  // 滑块拖到最左也不能把菜单拖成一张透明胶片：readSettings 有下限，落在 20%。
  check(
    'menu fill clamps to its floor',
    (await emit({ menuFill: 5 })).css.includes('var(--dshbg-raw-l1) 20%, transparent'),
  );
  // 模糊半径是同一个故事的第二条滑块：填充和模糊是一对，只调一边等于把问题挪个位置。
  const menu12 = await emit({ menuBlur: 12 });
  check(
    'menu blur follows the slider',
    menu12.css.includes('backdrop-filter: blur(12px) saturate(150%)') &&
      !menu12.css.includes('blur(40px)'),
  );
  // 上限 320px：半径超过表面自身尺寸之后结果就是背景的平均色，再往上只花 GPU 不换观感。
  check(
    'menu blur clamps to its ceiling',
    (await emit({ menuBlur: 500 })).css.includes('backdrop-filter: blur(320px) saturate(150%)'),
  );
  check(
    'menu blur reaches the sheet without a local cap',
    (await emit({ menuBlur: 300 })).css.includes('backdrop-filter: blur(300px) saturate(150%)'),
  );
  // 悬停卡和 tooltip 是「反色表面」：宿主的 --dsw-hovercard-bg 写死 #2C2C2E，字色写死
  // #fff / #cfd3d6，两套主题都是深的。所以不能转浅色玻璃（白字会糊掉），只能做
  // 「深色玻璃」——保留宿主自己的颜色、只把 alpha 拿掉，再用 backdrop-filter 磨平背后。
  // 用 color-mix(var(--宿主变量), transparent) 而不是写死色值，这样还跟着宿主的调色板走。
  check(
    'hover card becomes dark glass',
    base.css.includes('body > [class*="_card_"]') &&
      /body > \[class\*="_card_"\][\s\S]{0,40}?\{[^}]*color-mix\(in srgb, var\(--dsw-hovercard-bg\) (\d{1,3})%, transparent\)/.test(
        base.css,
      ),
  );
  // 卡片是 box-sizing:border-box 的固定 244px，1px border 会啃掉正文宽度，所以描边用 inset 阴影。
  // 悬停卡是**反色表面**（宿主写死白字），所以填充有个硬下限：滑块拉到 20% 时它仍然停在
  // 50%，否则白字会整片糊进亮壁纸里。这条盯的就是那个下限，别让人「统一」成同一个数。
  check(
    'hover card keeps a legibility floor',
    /body > \[class\*="_card_"\][\s\S]{0,80}?var\(--dsw-hovercard-bg\) 50%, transparent/.test(
      (await emit({ menuFill: 20 })).css,
    ),
  );
  check(
    'hover card rings without a border',
    /body > \[class\*="_card_"\][\s\S]{0,40}?\{[^}]*inset 0 0 0 1px/.test(base.css) &&
      !/body > \[class\*="_card_"\][\s\S]{0,40}?\{[^}]*border: 1px/.test(base.css),
  );
  // 短提示（快捷键那种）用 --dsw-alias-tooltip-bg，也是静态中性色。[data-side] 是 tooltip
  // 原语一定会写上的定位属性，消息气泡没有，用它挡掉误伤。
  check(
    'tooltip bubble becomes dark glass',
    /\[class\*="_bubble_"\]\[data-side\][\s\S]{0,40}?\{[^}]*color-mix\(in srgb, var\(--dsw-alias-tooltip-bg\) (\d{1,3})%, transparent\)/.test(
      base.css,
    ),
  );
  // 一屏几十个芯片。v2.47.0 之前这里讨论的是「模糊半径按最大值算会把 GPU 拖死，上限
  // 10px」—— 但半径压到多少都还是每帧一次快照，而芯片底下只有糊过的壁纸，那笔钱本来
  // 就不该花。现在一个都没有，半径自然也就不需要上限了。
  const chipMax = await emit({ glassBlur: 40 });
  check(
    'inline code takes no snapshot even at max blur',
    !ruleBody(chipMax.css, '[class*="_markdown_"]').includes('backdrop-filter'),
  );

  // 侧栏里的表面（新会话按钮、计费器）跟着侧栏走：只改工作区时侧栏要保持主题原样，
  // 给不透明的面板磨砂没有意义，还会成为这一列里唯一被碰过的元素。
  check('sidebar panes stay flat in work-area scope', !base.css.includes('_newSession'));
  // 用 $= 而不是 *=：按钮的子节点是 _newSessionContent / _newSessionLabel /
  // _newSessionLabelMask / _newSessionShortcut，全含 _newSession 子串，*= 会给它们
  // 各自套一层边框和投影。
  check('sidebar panes frost in whole-window scope', wide.css.includes('[class$="_newSession"]'));
  check('new-session children are not matched', !wide.css.includes('[class*="_newSession"]'));
  check('cost meter card is frosted with the sidebar', wide.css.includes('.cm-footer-stack.summary:not(.rail)'));
  // 侧栏整列底下只有壁纸，壁纸已经在 `html::before` 糊过 —— 这一列的任何表面都不该再花
  // 一次快照。v2.47.0 之前它们各自带 `blur(Npx) saturate()`，收益是零（糊的东西再糊一遍），
  // 代价是每帧一次全尺寸快照。
  for (const selector of ['[class$="_newSession"]', '.cm-footer-stack.summary:not(.rail)']) {
    check(
      `sidebar pane ${selector} takes no snapshot`,
      !ruleBody(wide.css, selector).includes('backdrop-filter'),
    );
  }
  // 侧栏历史记录：行与行只隔 2px（宿主 `_flatList > * + *`），给每一行各自一块圆角玻璃
  // 就必然变成「一串药丸」——文件夹和会话一样重，选中的那条还看不出来。所以是一整块背景
  // 托住列表，但**按内容收缩**（随对话增加而变高），不是撑满整列留一块空板子。
  check('history list gets a block behind it', wide.css.includes('[class*="_treeBody"]'));
  check(
    'history block shrink-wraps its rows',
    /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*flex: 0 1 auto/.test(wide.css) &&
      /\[class\*="_treeBody"\] \[class\*="_list"\][\s\S]{0,40}?\{[^}]*flex: 0 1 auto/.test(wide.css),
  );
  // 宿主 `_list` 是 `flex: 1`（basis 0%），在 auto 高度的父容器里会塌成 0，所以上面那条
  // 内层规则不是冗余，是必需品。
  // v2.47.0：侧栏这一列底下只有壁纸，而壁纸已经糊过了 —— 不再自带 backdrop 快照。
  check('history block takes no backdrop snapshot', !ruleBody(wide.css, '[class*="_treeBody"]').includes('backdrop-filter'));
  // 环用 inset 阴影，不用 border：_list 用负边距给滚动条让位，content-box 上 1px 边框会把
  // 那条槽推歪。
  check(
    'history block draws its ring without a border',
    /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*inset 0 0 0 1px/.test(wide.css) &&
      !/\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*border: 1px/.test(wide.css),
  );
  check(
    'history block keeps rows off its rounded corners',
    /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*padding: 6px 0/.test(wide.css),
  );
  // 黑度必须和计费器一模一样。之前块是 `--dshbg-raw-l1` 52%，计费器走 glassPane 的
  // `--dshbg-raw-base` 22% —— 两个 token、两个比例，于是块像一块黑板、底下计费器像块亮玻璃，
  // 用户直接指出来了。现在两边都读 `paneFill()`，这条断言就是「不许再分叉」的闸：
  // 拿计费器规则里的 background-color 去和块规则里的比，字符串必须完全相等。
  {
    const blockFill = /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*background-color: ([^!]+?) !important/.exec(
      wide.css,
    );
    const meterFill = /\.cm-footer-stack\.summary:not\(\.rail\)[^{]*\{[^}]*background-color: ([^!]+?) !important/.exec(
      wide.css,
    );
    check(
      'history block shares the cost meter fill',
      blockFill !== null && meterFill !== null && blockFill[1].trim() === meterFill[1].trim(),
    );
    // 顺便钉住那个值本身：分叉时两边一起改也是「相等」的，但那就不是 pane 配方了。
    check(
      'sidebar panes stay on the pane fill',
      blockFill !== null && /var\(--dshbg-raw-base\) 22%/.test(blockFill[1]),
    );
  }
  // 行必须保持原样：任何一条行级背景都会把宿主的选中态盖掉，层级就没了。
  check('history rows are left to the host', !wide.css.includes('_sessionRow') && !wide.css.includes('_projectRow'));
  // 宿主的 _fade 钉在 _treeBody 底部；块一收缩，它就压在最后一行上白掉一层。
  check('history block drops the host fade', /\[class\*="_treeBody"\] \[class\*="_fade"\][\s\S]{0,40}?\{[^}]*display: none/.test(wide.css));
  // 三样东西共用一对边：新会话按钮（宿主自带 margin: 0 2px）、历史块、计费器。
  // 块的右边要多补一个 edge-inset——`_listArea` 的负边距把容器自身撑宽了 12px，
  // 只写 2px 会让块比按钮正好宽 12px（复刻页量过）。
  check(
    'history block lines up with the new-session button',
    /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*margin-left: 2px/.test(wide.css) &&
      /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*margin-right: calc\(var\(--dsh-session-list-edge-inset\) \+ 2px\)/.test(wide.css),
  );
  // 计费器是 `_footerActions`（行向 flex）里的 flex item，宽度必须**明写**：
  // 交回 `auto` 就落回 flex 算法，卡片收缩到最长那行文字，右边短 28px（实测）。
  // 宽度用百分比，再减掉按钮自己的 margin——这样它落在按钮的边上，插件不需要知道
  // 任何像素值。
  check(
    'cost meter lines up with the new-session button',
    /\.cm-footer-stack\.summary:not\(\.rail\)[\s\S]{0,600}?width: calc\(100% - 4px\)[\s\S]{0,80}?margin-inline: 2px/.test(
      wide.css,
    ) &&
      !/\.cm-footer-stack\.summary:not\(\.rail\)[\s\S]{0,600}?\{[^}]*width: auto/.test(wide.css),
  );
  // Windows 上宿主把按钮的 margin-left 改成了 0（贴标题栏），计费器要跟着改，
  // 否则左边会多出 2px。
  check(
    'cost meter follows the Windows button inset',
    /html\[data-dshbg-on\]\[data-windows-titlebar\] \.cm-footer-stack\.summary:not\(\.rail\)[\s\S]{0,40}?\{[^}]*width: calc\(100% - 2px\)[\s\S]{0,60}?margin-left: 0/.test(
      wide.css,
    ),
  );

  // 输入框下面那条状态栏（[data-composer-dock]）自己不铺任何底色，转写区的文字直接从
  // 底下穿过去，所以它读起来是「贴着窗口边的一行散字」而不是一条状态栏。它跟输入框
  // 是一个整体，所以归属也跟输入框一致：实心模式就不磨砂。
  check('status row becomes a pane', glass.css.includes('[data-composer-dock]'));
  check('status row gets its own radius', /\[data-composer-dock\][^{]*\{[^}]*border-radius: 12px/.test(glass.css));
  // 这条状态栏是**唯一**一个还留真 `backdrop-filter` 的 pane。别的表面底下只有糊过的壁纸，
  // 再糊一遍是白花钱；它浮在转写区上面，消息滚到底时底下就是正文 —— 只给填充，那些字会
  // 透上来糊成一片。输入框卡片同理，所以两处共用同一个 `menuBlurOf`。
  check(
    'status row is frosted, unlike every other pane',
    /\[data-composer-dock\][^{]*\{[^}]*backdrop-filter: blur\(\d+px\) saturate\(160%\)/.test(glass.css),
    glass.css.match(/\[data-composer-dock\][^{]*\{[^}]*\}/)?.[0],
  );
  // 「跟输入框一样的磨砂」不能靠两处各写一个数字来保证 —— 那是会漂的。把旋钮拧到一个
  // 不常见的值，两处必须一起动。
  const frostedTwice = await emit({ composerStyle: 'glass', menuBlur: 27 });
  const blurOfRule = (css, selector) => {
    const rule = css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`));
    return rule === null ? null : (rule[0].match(/backdrop-filter: blur\((\d+)px\)/) || [])[1];
  };
  const dockBlur = blurOfRule(frostedTwice.css, '\\[data-composer-dock\\]');
  const cardBlur = blurOfRule(frostedTwice.css, '\\[data-composer-card\\]');
  check(
    'the dock and the message box read the same blur knob',
    dockBlur === '27' && cardBlur === '27',
    `dock ${dockBlur} / card ${cardBlur}`,
  );
  // 「回到最下面」那颗圆钮浮在正文上面，所以用比 pane 重的填充，并且要留住投影 ——
  // 换掉 box-shadow 就等于把宿主给的 --dsw-elevation-panel 弄丢了，它会看起来贴在纸上。
  check('jump-to-bottom disc is frosted', glass.css.includes('[class*="_toBottom"]:not([class*="_toBottomSlot"])'));
  check(
    'jump-to-bottom disc keeps its drop shadow',
    /_toBottomSlot"\]\)\s*\{[^}]*0 10px 30px -14px/.test(glass.css),
  );
  check('jump-to-bottom disc follows the finish switch', !base.css.includes('_toBottom'));
  check('status row stays flat in solid mode', !/\[data-composer-dock\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  // 「费用明细」是计费器自己的 .cm-btn，画 --dsw-alias-button-elevated-fill；这个 token
  // 不在 SURFACE_TOKENS 里，暗色主题下它解析成静态的 #43454a，重混够不到，所以它一直
  // 是黑胶囊。计费器把这个按钮注册了两处 —— 头部槽里一颗、这条状态栏里一颗，用户只留
  // 下面那颗，所以头部那颗整条 display: none。
  check('cost pill in the dock is frosted', glass.css.includes('[data-composer-dock] .cm-btn'));
  check(
    'cost pill keeps the host border width',
    /\[data-composer-dock\] \.cm-btn[^{]*\{[^}]*border: 1px solid/.test(glass.css),
  );
  check(
    'cost pill stays flat in solid mode',
    !/\[data-composer-dock\] \.cm-btn[^{]*\{[^}]*backdrop-filter/.test(base.css),
  );
  // 隐藏不受「质感」开关管辖：它不是装饰，是「同一颗按钮出现了两次」这个问题的修复，
  // 实心模式下也不该冒出来。所以断言落在 base（mode=glass 之外的实心档）上。
  const HEADER_COST_SEL = '[data-slot="conversation.session.header.actions"] .cm-btn';
  check('header cost entry is hidden', base.css.includes(HEADER_COST_SEL));
  check(
    'header cost entry is display: none',
    new RegExp(`\\[data-slot="conversation\\.session\\.header\\.actions"\\] \\.cm-btn \\{[^}]*display: none`).test(base.css),
  );
  // 收口在头部槽里，否则底部那颗（以及统计弹窗里的）会被一起藏掉。
  check('header cost rule is scoped to the slot', !/^html\[data-dshbg-on\] \.cm-btn \{/m.test(base.css));

  // 头部那排胶囊（智能体团队 / 标准模式 / 4 个子智能体）全部由 header.actions 这一个槽
  // 渲染，宿主只给它一个空壳 div，所以「槽里每个 button」正好等于「标题旁边那排胶囊」。
  // 但下拉触发器（_trigger / _switcherTrigger）要排除：给一个开下拉的按钮常驻一块底色，
  // 读起来像「按下去没弹起来」，玻璃应该出现在弹出来的面板里。
  check(
    'header chips are frosted as a row',
    glass.css.includes('[data-slot="conversation.session.header.actions"] button'),
  );
  check(
    'popover triggers are left bare',
    glass.css.includes('[data-slot="conversation.session.header.actions"] button:not([class*="_trigger"])'),
  );
  check(
    'header chips keep the hairline border',
    /\[data-slot="conversation\.session\.header\.actions"\] button:not\(\[class\*="_trigger"\]\) \{[^}]*border: \.5px solid/.test(glass.css),
  );
  // 面板本身宿主已经磨砂过（--dsw-specific-menu + --dsw-menu-backdrop-filter 画在 ::before 上），
  // 但里面的成员卡画 --dsw-alias-bg-layer-2，是主题自己的深色层，透在面板里就是一块黑洞。
  // 面板虽然 position:fixed，DOM 上仍是槽的后代，所以用槽收口 —— workflow 面板里也有一个
  // _memberButton，不收口会一起被套上。
  // 团队面板是 createPortal 渲染到 document.body 的，**不在 header 槽的 DOM 子树里** ——
  // 所以只能靠面板自己的 data-team-panel 收口。面板内部有两处画
  // --dsw-alias-bg-layer-2：成员卡（button.member）和任务卡（div.task），
  // 在已经磨砂的面板里都是黑洞。任务卡靠面板内的 token 重混，成员卡再加一层芯片。
  const TEAM_PANEL = '[data-team-panel]';
  const MEMBER_SEL = '[data-team-panel] button[class*="_member"]';
  check('team panel is addressed by its own data attribute', glass.css.includes(TEAM_PANEL));
  check(
    'team panel remixes its inner layer token',
    /\[data-team-panel\]\s*\{[^}]*--dsw-alias-bg-layer-2: color-mix/.test(glass.css),
  );
  check('team roster member card is addressed', glass.css.includes(MEMBER_SEL));
  const memberRule = glass.css.slice(glass.css.indexOf(`${MEMBER_SEL} {`), glass.css.indexOf(`${MEMBER_SEL} {`) + 400);
  // 参照物是子智能体面板：它的行完全透明，只有 hover 有底色。芯片配方试过，不行 ——
  // 它的填充是 color-mix(--dshbg-raw-base 45%)，而 raw-base 由壁纸亮度推出来，
  // 深色壁纸下那张卡就是一块深藏青。没有填充就没有这种失败模式。
  check('member card loses its opaque fill', /member"\]\s*\{[^}]*background-color: transparent !important/.test(glass.css));
  check('member card loses the elevation stroke too', memberRule.includes('box-shadow: none'));
  check('member card tints on hover instead', /member"\]:(?:hover|focus-visible)/.test(glass.css));
  // 当前会话那张卡靠宿主自己的 business-primary 内描边区分，透明之后这条必须补回来。
  check('current member card keeps its ring', glass.css.includes('_memberCurrent"]'));
  // 槽位收口是错的：面板被 portal 走了，这条选择器一个元素都匹配不到。留着它只会让
  // 以后的人以为「已经收口过了」，而实际生效的是另一条。
  check('member card is no longer scoped to the header slot', !glass.css.includes('header.actions"] button[class*="_member"]'));
  check('team panel stays flat in solid mode', !base.css.includes('data-team-panel'));

  console.log('\ntitle marquee');
  // 标题是面包屑，宿主封顶 220px + text-overflow: ellipsis。CSS 自己算不出「藏了多少」，
  // 所以 clip 放在样式表里、距离由 JS 量出来交给 Web Animation。
  // 当前那一节是 <span>，祖先才是 <button>，两个都要选中；_crumbSeg/_crumbSep 也含
  // `_crumb` 子串，必须按名字排除掉，否则会把分隔符和容器一起当成可滚动的文本。
  const CRUMB_SEL = ':is(span, button)[class*="_crumb"]:not([class*="_crumbSeg"]):not([class*="_crumbSep"])';
  check('title stops drawing an ellipsis', /_crumb"\][^{]*\{[^}]*text-overflow: clip/.test(base.css));
  check('breadcrumb selector covers the span title', base.css.includes(':is(span, button)[class*="_crumb"]'));
  check('breadcrumb selector excludes the seg and sep', base.css.includes(':not([class*="_crumbSeg"]):not([class*="_crumbSep"])'));
  // 关掉背景时整张表是空的，clip 也跟着没了 —— 所以 JS 那边必须按激活属性停掉动画，
  // 否则标题会在没有 clip 的情况下继续滑动。
  check('title clip is scoped to the activation attribute', base.css.includes(`html[data-dshbg-on] ${CRUMB_SEL}`));

  // 距离的测量方式换过一次，换的原因值得留档：scrollWidth 读的是「内容边缘」，而
  // text-indent 动的正是这个边缘，所以动画一跑，每次重量都在读自己被挪过的结果。
  // Range 读的是文字本身的宽度，与盒子怎么裁无关。
  check('marquee measures the text with a Range', CODE.includes('createRange'));
  check('marquee no longer trusts scrollWidth first', CODE.indexOf('createRange') < CODE.indexOf('crumb.scrollWidth'));
  // inline-block 是 shrink-to-fit，text-indent 会参与首行 max-content 计算，所以往左
  // 拉文字同时也会把盒子拉窄 —— 触发 ResizeObserver 重启动画，形成自激。用 min-width 钉住。
  check('marquee pins the box width while running', CODE.includes("setProperty('min-width'"));
  check('marquee releases the pin when it stops', CODE.includes("removeProperty('min-width')"));
  // 观察面包屑导航而不是标题本身：观察标题会让自己的动画变成 resize 源。
  check('marquee observes the crumbs nav, not the crumb', CODE.includes('resize.observe(host)'));
  check('marquee does not observe the crumb itself', !CODE.includes('resize.observe(crumb)'));
  // 单向连续滚动：文字往左匀速走，走完「文字宽 + 间距」刚好和起点重合，循环无跳变。
  // 靠 ::after 复制一份接在后面（content 取 attr()，不动 React 管的文本节点），
  // 只复制一份的话每个循环里会有一半时间是空盒子。
  check('title repeat is a pseudo-element', base.css.includes(`${CRUMB_SEL}[data-dshbg-mq]`) && base.css.includes('::after'));
  check('title repeat takes its text from the attribute', base.css.includes('content: attr(data-dshbg-mq)'));
  check('title repeat keeps a gap before the seam', /::after\s*\{[^}]*margin-left: 32px/.test(base.css));
  check('marquee loop distance includes the gap', CODE.includes('metrics.text + MARQUEE_GAP'));
  // 不取整：循环距离必须严格等于「文字宽 + 间距」，否则每次接缝都会跳一下。
  check('marquee loop distance is not rounded', CODE.includes('loop.toFixed(2)'));
  check('marquee drops the repeat when it stops', CODE.includes("removeAttribute('data-dshbg-mq')"));
  check('marquee keeps the repeat in sync with the title', CODE.includes("getAttribute('data-dshbg-mq') !== text"));
  // 单向、匀速、无限循环：关键帧只有 from/to，中间没有停顿也没有回程。
  check('marquee animates one direction only', !CODE.includes("easing: 'ease-in-out'"));
  check('marquee travels at a constant speed', CODE.includes('loop / MARQUEE_SPEED'));
  // 动效搬到 CSS 里了。WAAPI 的动画是 JS 持有的对象，宿主每次重渲染把标题摘挂一次，
  // 挂在它身上的动画就被静默取消 —— 而声明式 CSS 在元素回到文档时会自己重新生效。
  // ⚠️ 这条只对标题成立：壁纸盒子反过来必须用 WAAPI（见 wallpaper 一节），所以不能全文禁。
  const marqueeCode = CODE.slice(
    CODE.indexOf('function installTitleMarquee('),
    CODE.indexOf('function installComposerMenuGuard('),
  );
  check(
    'marquee motion is declarative, not WAAPI',
    marqueeCode.length > 0 && !marqueeCode.includes('.animate(') && !marqueeCode.includes('animation.cancel'),
  );
  check('marquee animation is gated on the repeat attribute', /\[data-dshbg-mq\]\s*\{\s*animation: dshbg-marquee/.test(base.css.replace(/\n/g, '')));
  check('marquee distance travels through a custom property', CODE.includes('--dshbg-mq-loop'));
  // 重写自定义属性会让动画从零重新开始 —— 所以只在值真的变了才写。
  check('marquee rewrites the distance only when it changes', CODE.includes("getPropertyValue('--dshbg-mq-loop') !== distance"));
  check('marquee dropped the fixed-duration formula', !CODE.includes('7000 + shift * 60'));
  // 头部可能在还没有宽度的时候就挂载了，第一次测量读到 0 会直接放弃。
  check('marquee re-syncs after boot', /const retries = \[[^\]]+\]\.map/.test(CODE));
  check('marquee clears its retries on dispose', CODE.includes('for (const handle of retries) clearTimeout(handle)'));
  // 宿主的 max-width:220px 是给「截断 + 省略号」准备的。留着它，232px 的标题在几乎空着的
  // 头部里也会永远滚——它从来没被允许用旁边的空间。现在先按头部真实余量放宽，再量 shift：
  // 放得下就完全不滚，放不下才滚。这是用户明确要的规矩。
  check('title is widened to the room the header has', CODE.includes('_titleCluster') && CODE.includes('roomFor'));
  check('title cap is written only when it changes', CODE.includes("getPropertyValue('max-width') !== value"));
  check('title cap is content-box aware', CODE.includes("before.boxSizing === 'border-box' ? room"));
  // max-width 绝不能跟着「这条放得下」一起被摘掉：摘掉就回到 220，于是又放不下、又开始滚、
  // 再套回 max-width —— 两帧一次的自激。只有壁纸关掉时才还原。
  check('stopping the loop keeps the widened title', !/const stop = \(crumb\) => \{[^}]*max-width/.test(CODE));
  check('turning the wallpaper off restores the host cap', /const reset = \(crumb\) => \{[^}]*max-width/.test(CODE));
  // 跑马灯是这个插件里唯一「坏了也看不出来」的部分：不滚的标题和刚好放得下的标题长得一样。
  // 所以它把最后一次测量留在 localStorage 里，打包后的 App 没有 devtools 也能从磁盘读回来。

  console.log('\nwindow caption buttons');
  // Electron paints min/max/close natively, so no rule on the frame can reach them. The
  // preload publishes the overlay colour from a hidden probe it appends to <body>, and
  // re-reads it whenever <head> changes - so overriding the probe is the whole lever.
  check('caption probe is targeted', base.css.includes('body > span[style*="--dsw-specific-sidebar-fill"]'));
  check(
    'caption fill cleared so the strip shows',
    /span\[style\*="--dsw-specific-sidebar-fill"\]\s*\{[^}]*background-color: transparent !important/.test(base.css),
  );
  // Work-area scope keeps the strip solid, so the symbols have to follow the theme's own
  // label colour - the tone palette is chosen against the wallpaper and can land
  // dark-on-dark once the wallpaper is no longer behind them.
  check(
    'work-area symbols use the theme label colour',
    /span\[style\*="--dsw-specific-sidebar-fill"\]\s*\{[^}]*color: var\(--dshbg-raw-label-0\) !important/.test(base.css),
  );
  // Whole-window scope puts them straight on the artwork, so the measured tone applies.
  check(
    'whole-window symbols take the wallpaper tone',
    /span\[style\*="--dsw-specific-sidebar-fill"\]\s*\{[^}]*color: #12161d !important/.test(wide.css),
    'bright gradient should yield dark symbols',
  );
  const darkPaper = await emit({ gradient: 0, fullWindow: true });
  check(
    'symbols flip on a dark wallpaper',
    /span\[style\*="--dsw-specific-sidebar-fill"\]\s*\{[^}]*color: #f7f8fa !important/.test(darkPaper.css),
  );
  check('probe override is prefixed like everything else', !/(^|\})\s*body > span\[style/.test(base.css));

  console.log('\nwindow chrome');
  check('titlebar strip selector is compound', base.css.includes('html[data-dshbg-on][data-windows-titlebar]'));
  // The strip is window chrome. Clearing it made the wallpaper show through above the work
  // area, which only looked right while the sidebar was open: the gradient ended at
  // --dsh-windows-sidebar-width, and that track width drops to 0px as soon as the sidebar
  // closes, turning the whole strip back into a full-width band of wallpaper.
  check(
    'work-area strip stays the layout fill, full width',
    base.css.includes('::before { background: var(--dshbg-raw-sidebar) !important; }'),
  );
  check(
    'no strip geometry tied to the sidebar track width',
    !base.css.includes('--dsh-windows-sidebar-width'),
  );
  // 整窗模式的通栏只承担「同样的色」，不加模糊：它下面的栏是 token 重混（只有颜色、没有
  // 模糊），通栏一片糊、下面一片清，边界反而更跳。左半按侧栏浓度、右半按对话区浓度，
  // 在 --dsh-windows-sidebar-width 处硬断；侧栏收起时该变量为 0，整条自然变成工作区色。
  check(
    'whole-window strip tints like the columns it continues',
    /::before \{ background: linear-gradient\(to right,[\s\S]{0,260}?var\(--dshbg-raw-sidebar\) 30%, transparent\) 0,[\s\S]{0,260}?var\(--dshbg-raw-sidebar\) 30%, transparent\) var\(--dsh-windows-sidebar-width, 0px\),[\s\S]{0,260}?var\(--dshbg-raw-base\) 78%, transparent\) var\(--dsh-windows-sidebar-width, 0px\)\) !important; \}/.test(
      wide.css,
    ),
  );
  // 扫的是「画那条通栏渐变的那条规则」，不是「任何一个 ::before」—— 插件市场吸顶栏的
  // 14px 带子也是 ::before，它底下滚的是文字、本来就该模糊。按选择器种类扫会误伤。
  check(
    'whole-window strip does not blur what it covers',
    !/::before \{ background: linear-gradient\(to right,[\s\S]{0,400}?backdrop-filter/.test(wide.css),
  );
  check(
    'work-area strip is still never glass',
    !/::before \{ background: linear-gradient/.test(base.css),
  );
  check('no orphaned titlebar selector', !base.css.includes('] [data-windows-titlebar]'));
  check('content radius zeroed', base.css.includes('--dsh-windows-content-radius: 0px'));

  console.log('\nportaled surfaces (the black boxes)');
  // 重混必须落到 body 的直接子元素上：宿主设置弹窗、计费弹窗都是 #root 的**兄弟**，
  // 挂在框架上的重混永远够不到它们，它们就一直按主题原色画成黑板。
  check(
    'remix reaches every portal, not just the frame',
    /html\[data-dshbg-on\] body > \* \{[^}]*--dsw-alias-bg-base: color-mix/.test(base.css),
  );
  check('changed-files card becomes a pane', /\[data-changed-files\][^{]*\{[^}]*22%/.test(base.css));
  check('changed-files header stops painting black', /\[data-changed-files\] \{[^}]*--changes-fill: transparent/.test(base.css));
  // 「弹窗还是黑的」有一半算在遮罩身上：把背后压到 0.52 再叠深色玻璃，合成出来就是黑。
  // 现在几乎不再压暗，玻璃才有东西可透。
  check('the app behind a dialog is never filtered', !/#root[^{}]*\{[^}]*filter:/.test(base.css));
  check(
    'the dialog scrim never blurs the window',
    !/dialog::backdrop \{[^}]*backdrop-filter/.test(base.css),
  );
  // 宿主的遮罩故意不盖 Windows 顶栏（免得压暗原生按钮），所以弹窗一开，顶栏还是亮的、
  // 下面已经暗了 —— 那道横线就又出现。顶栏要单独补同一层压暗。
  check(
    'the title strip is pushed back with the app while a dialog is open',
    /:has\(\[role="dialog"\]\[aria-modal="true"\]\)[^{]*::before[\s\S]{0,160}?inset 0 0 0 100vmax var\(--dsw-alias-bg-mask-1/.test(
      base.css,
    ),
  );
  // 设置弹窗要和菜单/输入框同一个材料，否则它就是满窗唯一一块黑板。
  check(
    'host dialogs use the menu material',
    /\[role="dialog"\]\[aria-modal="true"\] \{[\s\S]{0,220}?var\(--dshbg-raw-base\) \d{2}%[\s\S]{0,300}?backdrop-filter: blur\(/.test(
      base.css,
    ),
  );
  // ⚠️ 面板和遮罩是**两层**，各自「一半」合成出来是 73% 不透明 —— 壁纸只剩 27%，
  // 在深色壁纸上等于没有。滑杆上的数字不是屏幕上的数字。这条断言算的是后者：
  // 以后谁把任何一层调回去，这里就会红，而不是等用户再截一张黑板。
  const dialogFill = Number(
    (base.css.match(/\[role="dialog"\]\[aria-modal="true"\] \{[^}]*?var\(--dshbg-raw-base\) (\d+)%/) || [])[1],
  );
  const scrimFill = Number(
    (base.css.match(/\[role="presentation"\]:has\(> \[role="dialog"\]\[aria-modal="true"\]\) > div\[aria-hidden="true"\] \{[^}]*?rgb\(0 0 0 \/ (\d+)%\)/) ||
      [])[1],
  );
  const composite = 1 - (1 - dialogFill / 100) * (1 - scrimFill / 100);
  check(
    `the panel and its own scrim do not add up to a slab (${Math.round(composite * 100)}% opaque)`,
    dialogFill > 0 && scrimFill > 0 && composite <= 0.6,
  );
  // 卡片不能按全局密度重混：那是「控件凸起」的不透明中性色，压在半透明面板上合成回 91%，
  // 面板成了玻璃、卡片还是塑料。改成标签色的纱 —— 白纱在任何壁纸上都比底下亮，
  // 而半透明中性色在亮壁纸上会变成最暗的那块。
  check(
    'cards inside the dialog are a label wash, not a remixed neutral',
    /\[role="dialog"\]\[aria-modal="true"\] \{[^}]*--dsw-alias-settings-card-fill: color-mix\(in srgb, var\(--dshbg-raw-label-0\)/.test(
      base.css,
    ),
  );
  check(
    'the raised nav item takes the same wash',
    /\[role="dialog"\]\[aria-modal="true"\] \{[^}]*--dsw-specific-sidebar-nav-item-active: color-mix\(in srgb, var\(--dshbg-raw-label-0\)/.test(
      base.css,
    ),
  );
  check(
    'the wash never reuses the opaque neutral it replaces',
    !/\[role="dialog"\]\[aria-modal="true"\] \{[^}]*--dsw-alias-bg-module-platform: color-mix\(in srgb, var\(--dshbg-raw-module\)/.test(
      base.css,
    ),
  );
  check(
    'the plugin page never paints an opaque sheet',
    !/\[data-dshbg-config\][^{]*\{[^}]*background-color: var\(--dshbg-raw-base\) !important/.test(base.css) &&
      /\[data-dshbg-config\][^{]*\{[^}]*background-color: transparent !important/.test(base.css),
  );

  console.log('\nsettings page');
  check('opaque rule is driven by the mount marker', base.css.includes('html[data-dshbg-on][data-dshbg-config]'));
  check('both work-area columns are scoped', (base.css.match(/html\[data-dshbg-on\]\[data-dshbg-config\][^{},]*nth-of-type\([23]\)/g) || []).length === 2);
  check('restores theme text on the page', base.css.includes('--dsw-alias-label-primary: var(--dshbg-raw-label-0) !important'));
  check('does not target the centred detail block', !base.css.includes('[data-plugin-detail]'));
  // Whole-window scope: the sidebar is glass there, so the opaque page must cover it too
  // or the page sits beside a see-through strip.
  const wideConfig = /html\[data-dshbg-on\]\[data-dshbg-config\][^{},]*div:has\(> \[data-shell-overlay\]\)\s*\{/.test(wide.css);
  const wideConfigStillColumnar = /html\[data-dshbg-on\]\[data-dshbg-config\][^{}]*nth-of-type/.test(wide.css);
  check('whole-window scope covers the sidebar as well', wideConfig && !wideConfigStillColumnar);

  console.log('\ntext colour');
  // Theme mode must leave the label tokens alone. The caption symbols are a separate
  // consumer of the palette and are expected to appear here regardless of font mode.
  check('theme mode leaves label tokens untouched', !/--dsw-alias-label-primary: #/.test(base.css));
  const autoBright = await emit({ font: 'auto' });
  check('auto mode inverts on a bright gradient', autoBright.css.includes('--dsw-alias-label-primary: #12161d'));
  const forced = await emit({ font: 'light' });
  check('light mode forces the light palette', forced.css.includes('--dsw-alias-label-primary: #f7f8fa'));
  const custom = await emit({ font: 'custom', fontColor: '#ff0000' });
  check('custom mode uses the picked colour', custom.css.includes('--dsw-alias-label-primary: #ff0000'));
  check('custom mode derives the secondary tone', custom.css.includes('color-mix(in srgb, #ff0000 80%, transparent)'));

  console.log('\ncost-meter shim');
  // ⚠️ 这里断言的是**性质**不是写法：`cm-section` 是设置弹窗的子元素，弹窗已经画过底，
  // 它自己再画一层就是同一个矩形画两遍（surface 50 时内容列合成 ~75%，旁边的导航列只有
  // 49%，壁纸在面板中间断成一条竖线）。所以断言「它自己是透明的」，而不是「它拿到了某个值」。
  check(
    'the cost meter section paints no fill of its own',
    /html\[data-dshbg-on\] body \.cm-section \{[^}]*background: transparent !important/.test(base.css),
  );
  check(
    'and nothing colour-mixes it back',
    !/\.cm-section[^{}]*\{[^}]*color-mix/.test(base.css),
  );
  check(
    'the sidebar cost meter blocks keep theirs',
    /html\[data-dshbg-on\] body \.cm-footer-stack\.simple[^{]*\{[^}]*color-mix/.test(base.css),
  );
  // 弹窗玻璃**不再由本插件负责**：费用明细自己的样式表在安装时已经打了补丁（ENGINEERING.md
  // 里有完整记录）。两边同时上色只会互相盖，而且它的规则永远更靠近宿主，所以这里断言本插件
  // 的样式表**不再提** `.cm-stat-dialog` —— 谁改了这条，都会把弹窗重新推回互相覆盖。
  check('the dialog itself is left to the plugin', !base.css.includes('.cm-stat-dialog'));
  let installedCostMeter = null;
  try {
    installedCostMeter = fs.readFileSync(
      `${process.env.USERPROFILE}/.dsh/profiles/desktop/node_modules/dsh-cost-meter/lib/client.js`,
      'utf8',
    );
  } catch {
    installedCostMeter = null;
  }
  check(
    'the installed cost meter carries the glass patch',
    installedCostMeter === null || installedCostMeter.includes('color-mix(in srgb,#ffffff 14%,transparent)'),
    installedCostMeter === null ? 'not installed on this machine - skipped' : '',
  );

  // 插件市场的全屏页：它自己用 layer-1 画底，而 layer-1 的语义是「比 pane 高一层」，
  // 带着 +8 的 lift。它不是 pane 之上的面板，它**就是**页面本身 —— 打开市场整窗比刚才的
  // 对话暗八个百分点，看起来就像另开了一层板。
  //
  // 但它也**不该**照抄对话区的 22%：整页都是 12px 小字直接坐在页面上，底下一亮字就发飘。
  // 45% 是「字站得住、壁纸还是张照片」的位置。所以断言的是「它自己画底、不是 layer-1 的
  // lift」，以及「浓度明显高于对话区」—— 不是钉死某个数字。
  console.log('\nplugin market');
  const MARKET_PAGE = '\\[data-dsh-market-plugins-tab="true"\\]\\[data-dsh-market-fullscreen="true"\\]';
  const marketRule = new RegExp(
    `html\\[data-dshbg-on\\] ${MARKET_PAGE} \\{[^}]*?background: color-mix\\(in srgb, var\\(--dshbg-raw-base\\) (\\d+)%, transparent\\)`,
  );
  const marketFill = marketRule.exec(base.css);
  check('the market page paints its own base instead of the layer-1 lift', marketFill !== null);
  check(
    'and it is heavier than a chat pane, because its body text sits straight on the page',
    marketFill !== null && Number(marketFill[1]) >= 40,
    marketFill === null ? '' : `fill ${marketFill[1]}%`,
  );
  check(
    'and the rule is gated on the wallpaper switch, so turning it off restores the original',
    base.css.includes(`html[data-dshbg-on] [data-dsh-market-plugins-tab="true"]`),
  );
  // 卡片要的是「标签纱」，不是再糊一遍：底下的壁纸已经被滑杆糊过了，再上 backdrop-filter
  // 看不出区别，只多一层合成。真正让卡片从塑料变玻璃的是填充 —— 中性色重混成 60% 暗会
  // 变成屏幕上最暗那块，白纱不会。测的是「填充是纱」，不是某个具体字符串。
  check(
    'the market cards are a label wash rather than the remixed neutral',
    /\[data-dsh-market-root\] \{[^}]*?--dsw-alias-settings-card-fill: color-mix\(in srgb, var\(--dshbg-raw-label-0\) 12%/.test(
      base.css,
    ),
  );
  // 吸顶栏是这里唯一需要真模糊的地方：它底下滚过的是**内容**（卡片、价格、正文），不是
  // 糊过的壁纸。50% 的 bg-base 挡不住文字，标题、搜索框、筛选条会被穿过去。
  check(
    'the market sticky header occludes the cards scrolling under it',
    /\[data-dsh-market-root\] \[class\$="_stickyHead"\] \{[^}]*?background: color-mix\(in srgb, var\(--dshbg-raw-base\) 45%, transparent\)[^}]*?backdrop-filter: blur\(/.test(
      base.css,
    ),
  );
  // 那 14px 的 `::before` 带子只会继承填充、不会继承模糊 —— 它是「只修了看得见的那条」的指纹。
  check(
    'and so does the strip above it, which only inherits the fill',
    /\[class\$="_stickyHead"\]::before \{[^}]*?backdrop-filter: blur\(/.test(base.css),
  );

  console.log('\nnative form controls');
  check(
    'the select widget is put in dark mode',
    /html\[data-dshbg-on\] select \{[^}]*color-scheme: dark !important/.test(base.css),
  );
  // ⚠️ 断言的是**性质**：这个列表画在文档的层叠上下文之外，读不到底下是什么，所以它的底色
  // 必须是不透明的。给它 `transparent` 或任何 `color-mix(… transparent)` 都会退回「半透明
  // 色合成在弹层白底上」那个灰色 —— 实测 (127,127,128) 正好是 #151517 在 55% 下压白底。
  check(
    'and its option rows are filled with a solid colour',
    (() => {
      const rule = /html\[data-dshbg-on\] select option,[\s\S]{0,140}?\{([^}]*)\}/.exec(base.css);
      if (rule === null) return false;
      const fill = /background-color:\s*([^;]+);/.exec(rule[1]);
      if (fill === null) return false;
      return !/transparent/.test(fill[1]) && !/color-mix/.test(fill[1]);
    })(),
  );

  console.log('\nlifecycle');
  const off = await emit({ mode: 'none' });
  check('mode none injects an empty stylesheet', off.css === '', `length ${off.css.length}`);
  // The marquee's `text-overflow: clip` rides the same sheet, so switching the background
  // off has to take it with it - otherwise a scrolling title keeps its ellipsis pinned.
  check('title clip goes away with the stylesheet', !off.css.includes('_crumb'));
  check('mode none leaves <html> unmarked', !off.documentElement.hasAttribute('data-dshbg-on'));
  check(
    'and takes the wallpaper container with it',
    off.body.children.every((el) => !el.hasAttribute('data-dshbg-stack')),
  );
  // 第二个座位是临时调参卡。它和设置页互不依赖：任何一边缺失都不能把另一边带崩。
  check('mode none still registers the config page', off.registered.length === 1, `got ${off.registered.length}`);

  // Nothing else in this file calls the page component, so a typo in the JSX would only
  // surface in the app. Render it once and look for the controls by their label text.
  console.log('\nconfig page render');
  let page = null;
  try {
    page = base.registered[0].component({ view: 'page' });
  } catch (failure) {
    page = null;
  }
  check('page renders without throwing', page !== null);
  const strings = [];
  // Switch and Slider are function components, so their labels sit in props rather than
  // in children - walking children alone silently misses every control caption. Segmented
  // keeps its labels one level deeper still, inside a plain `options` array.
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return;
    if (typeof node === 'string' || typeof node === 'number') {
      strings.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.type !== undefined) {
      if (node.props !== null && typeof node.props === 'object') {
        Object.values(node.props).forEach(walk);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(page);
  const blob = strings.join('\n');
  if (process.argv.includes('--dump')) console.log(`\n--- config page strings (tail) ---\n${blob.slice(-1400)}\n--- len ${blob.length} ---`);
  check('scope switch is on the page', blob.includes('同时应用到左侧对话栏'));
  check('conversation opacity control is on the page', blob.includes('对话区不透明度'));
  check('composer opacity control is on the page', blob.includes('输入框不透明度'));
  check('finish control is on the page', blob.includes('液态玻璃'));
  check('panel opacity control is still there', blob.includes('面板不透明度'));

  // The sliders belong to one background now, and the page has to say so - otherwise the
  // first switch looks like the plugin lost the user's settings.
  const withImage = await emit({ mode: 'image', imageId: 'img-1', composerStyle: 'glass' });
  const imageStrings = [];
  const collect = (node) => {
    if (node === null || node === undefined || node === false || node === true) return;
    if (typeof node === 'string' || typeof node === 'number') {
      imageStrings.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.type !== undefined) {
      if (node.props !== null && typeof node.props === 'object') Object.values(node.props).forEach(collect);
      if (Array.isArray(node.children)) node.children.forEach(collect);
      return;
    }
    Object.values(node).forEach(collect);
  };
  collect(withImage.registered[0].component({ view: 'page' }));
  const imageBlob = imageStrings.join('\n');
  check('the page says the sliders belong to the current background', imageBlob.includes('属于当前这张背景'));
  check('the page says glass blur is global', imageBlob.includes('玻璃模糊、作用范围、字体是全局的'));

  console.log('\nper-background settings');
  // Every key in DEFAULTS must land in exactly one of the three groups. A key that belongs
  // to none of them is silently dropped by `applySettingsPatch` - the slider moves, nothing
  // is stored, and the value snaps back on the next commit. Cheap to assert, expensive to
  // find by hand.
  const keysOf = (name) => {
    const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(CODE);
    return match === null
      ? []
      : match[1]
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
  };
  const pointers = keysOf('POINTER_KEYS');
  const perSource = keysOf('PRESENTATION_KEYS');
  const globals = keysOf('GLOBAL_KEYS');
  const defaultsBody = /const DEFAULTS = \{([\s\S]*?)\n    \};/.exec(CODE);
  const defaultKeys = defaultsBody === null ? [] : [...defaultsBody[1].matchAll(/^ {6}([A-Za-z]+):/gm)].map((m) => m[1]);
  const classified = pointers.concat(perSource, globals);
  check('DEFAULTS was found', defaultKeys.length >= 15, `got ${defaultKeys.length}`);
  check(
    'every default is classified into a group',
    defaultKeys.every((key) => classified.includes(key)),
    defaultKeys.filter((key) => !classified.includes(key)).join(', '),
  );
  check('no key belongs to two groups', new Set(classified).size === classified.length);
  check('glass blur stays global, as asked', globals.includes('glassBlur') && globals.includes('menuBlur'));
  check(
    'blur and dim are per background',
    perSource.includes('blur') && perSource.includes('dim') && perSource.includes('surface'),
  );
  check('the artwork pointers are not presentation keys', !perSource.some((key) => pointers.includes(key)));

  console.log('\nslot registration');
  // 只留设置页那一个座位。调参卡已经不是座位了（见上）。
  check('one slot registration', base.registered.length === 1, `got ${base.registered.length}`);
  if (base.registered.length > 0) {
    const { options } = base.registered[0];
    check('registers into plugins.bundle.config', options.name === 'plugins.bundle.config');
    check('keyed by the package name', options.key === '@local/dsh-custom-background', options.key);
  }

  console.log('\ncss syntax sanity');
  const open = (base.css.match(/\{/g) || []).length;
  const close = (base.css.match(/\}/g) || []).length;
  check('braces balanced', open === close, `${open} vs ${close}`);
  check('no unresolved template literal', !base.css.includes('${'));
  check('no stray block comments', !base.css.includes('/*'));

  // The trap that bit an earlier build: a shared prefix binds only to the first
  // selector in a comma list, leaving the rest as bare selectors that match
  // unconditionally. Every selector the plugin emits must be activation-scoped.
  const selectors = [];
  // `@keyframes` 的 `from` / `to` 也是「选择器」形状，但它们不是选择器、也不需要激活前缀。
  // 先把整个 at-rule 块挖掉再扫，否则每次加动画都会误报。
  const keyframes = [];
  // 三份 CSS 一起扫：只改工作区、整窗、玻璃质感各是一套输出，只扫其中一份会漏掉
  // 只在另一套里出现的规则——侧栏那段就是这样漏掉过一次，`[class*="_projectRow"]:hover`
  // 少了前缀也没人发现。
  const scanned = [base.css, wide.css, glass.css].join('\n');
  const withoutKeyframes = scanned.replace(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g, (_, name, body) => {
    keyframes.push({ name, body });
    return '';
  });
  const headerRe = /(?:^|\})\s*([^{}]+)\{/g;
  // Commas inside `:is(...)` / `:has(...)` belong to one selector, not to a list - splitting
  // on every comma would cut `:is(span, button)` in half and then complain that `button)...`
  // is unscoped.
  const splitSelectors = (text) => {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    parts.push(current);
    return parts;
  };
  let match;
  while ((match = headerRe.exec(withoutKeyframes)) !== null) {
    for (const part of splitSelectors(match[1])) {
      const selector = part.trim();
      // An at-rule header (`@media (prefers-reduced-motion: reduce)`) is not a selector. Its
      // *contents* still are, and they reach this loop on their own because the block's
      // closing brace puts them at the start of a header.
      if (selector.length > 0 && !selector.startsWith('@')) selectors.push(selector);
    }
  }
  const unscoped = selectors.filter((selector) => !selector.startsWith('html[data-dshbg-on]'));
  check('every selector carries the activation prefix', unscoped.length === 0, unscoped.slice(0, 3).join(' | '));
  check('selector scan saw the whole sheet', selectors.length >= 18, `parsed ${selectors.length}`);
  // 动画本体在 @keyframes 里，它只许动 text-indent。用 transform 会把整个盒子（连悬停
  // 底色和点击区域）一起拖走；动别的属性则可能把标题盒子的宽度牵进布局反馈。
  const marqueeFrames = keyframes.find((frame) => frame.name === 'dshbg-marquee');
  check('marquee keyframes exist', marqueeFrames !== undefined);
  if (marqueeFrames !== undefined) {
    check('marquee keyframes only move text-indent', marqueeFrames.body.includes('text-indent') && !marqueeFrames.body.includes('transform'));
    check('marquee keyframes take their distance from a variable', marqueeFrames.body.includes('var(--dshbg-mq-loop'));
    check('marquee keyframes go one way only', marqueeFrames.body.includes('from') && marqueeFrames.body.includes('to') && !marqueeFrames.body.includes('%'));
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
  if (DUMP) {
    console.log(`\n--- emitted css (default settings) ---\n${base.css}`);
    console.log(`\n--- emitted css (fullWindow) ---\n${wide.css}`);
    const lit = await emit({ font: 'auto' });
    console.log(`\n--- emitted css (font: auto) ---\n${lit.css}`);
    const glassy = await emit({ composerStyle: 'glass' });
    console.log(`\n--- emitted css (liquid glass) ---\n${glassy.css}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});
