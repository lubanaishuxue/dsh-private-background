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
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const vm = require('vm');

const ROOT = process.env.DSHBG_ROOT ? path.resolve(process.env.DSHBG_ROOT) : path.join(__dirname, '..');

const CLIENT = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : 'D:/dsh-plugins/custom-background/client.js',
);
const DUMP = process.argv.includes('--dump');
const CODE = fs.readFileSync(CLIENT, 'utf8');
// The package name is compared, not hard-coded: it changed once already (the `@local/`
// scope was a local-development convention, not something to publish under), and an
// assertion that pins the literal only ever proves the literal is still there.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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
    // 真实 DOM 的 `style` 有 `setProperty` / `removeProperty`（真正的方法定义在下面，
    // 因为它要闭包住 `el._vars`）。本插件用它们写自定义属性 —— `--dshbg-head-img` 那几百 KB
    // 的 data URL 就是这么进 CSS 的。值另存一份，测试就能断言「变量到底写在了哪个元素上」：
    // 1.3.39 把它从表头挪到 `<html>`，有没有搬错靠的就是这个。
    _vars: new Map(),
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
    // 自定义属性的三个方法（见上面 `_vars` 那段）。写在 `style` 上而不是元素上，
    // 因为 `client.js` 调的是 `el.style.setProperty(...)`。
    style: {
      setProperty(name, value) { el._vars.set(name, String(value)); },
      removeProperty(name) { el._vars.delete(name); },
      getPropertyValue(name) { return el._vars.has(name) ? el._vars.get(name) : ''; },
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
  // 副作用体当场跑一遍（cleanup 不跑）。React 是在提交后跑，桩里没有提交那一步；但「挂载时
  // 把图标钉回去」这类行为只存在于 effect 里，一次都不跑就等于没测。
  useEffect: (fn) => { fn(); },
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
  const noPinControl = extra !== undefined && extra.noPinControl === true;
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
  // 宿主侧的第二道闸：`sidebar.panellist` 的行可以被「取消固定」，被取消的行不在列表里，
  // 只在「更多」里。它是内存状态（`ui-sidebar/src/client/panel-pins.ts`），与 slot 注册彼此
  // 独立 —— 所以「注册了」不等于「看得见」。桩里必须把它也建模，否则这条永远测不出来。
  const pins = {
    unpinned: [],
    calls: [],
    subscribes: 0,
    listeners: new Set(),
    // 宿主里这一行是「判定要不要改 → 改 → 通知订阅者」。桩里照抄这条链路：
    // 测试要能模拟「用户在左栏点了图钉」，那是**不经过插件**的一次外部改动。
    set(id, pinned) {
      const has = pins.unpinned.includes(id);
      // 和宿主同一条规则：请求与现状已经一致时什么都不做。
      if (pinned !== has) return;
      pins.unpinned = pinned ? pins.unpinned.filter((entry) => entry !== id) : [...pins.unpinned, id];
      for (const listener of [...pins.listeners]) listener();
    },
    /** 模拟用户在左栏点「从左侧栏取消固定」。 */
    unpin(id) {
      pins.set(id, false);
    },
  };
  const pinFace = {
    setPinned(id, pinned) {
      pins.calls.push([id, pinned]);
      pins.set(id, pinned);
    },
    hooks: {
      entryPins: {
        getSnapshot: () => pins.unpinned,
        subscribe: (listener) => {
          pins.subscribes += 1;
          pins.listeners.add(listener);
          return () => {
            pins.listeners.delete(listener);
          };
        },
      },
    },
  };
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    slots: {
      // 宿主的 `inject` 返回一个「撤掉等待 + 撤掉贡献」的 disposer；桩里两个都要能撤，
      // 否则「关掉开关 → 图标消失」这条根本没法验证。
      inject(name, callback) {
        const disposer = callback();
        return () => { if (typeof disposer === 'function') disposer(); };
      },
      register(options, component) {
        const entry = { options, component, disposed: false };
        registered.push(entry);
        return () => {
          if (entry.disposed) return;
          entry.disposed = true;
          const index = registered.indexOf(entry);
          if (index !== -1) registered.splice(index, 1);
        };
      },
      // 外壳那条注册带着私有注入面（`SidebarRootInjected`），`setPinned` 就在里面。
      // 形状照着宿主来：`StoredEntry.inject` 在**顶层**（`scoped-slots.tsx` 读的是
      // `entry.inject`），不在 `options` 里 —— 桩要是照着自己以为的形状写，这条就白测了。
      // `extra.noPinControl` 模拟「宿主换掉了这个面」——那时开关必须照常工作。
      entriesOfSlot(name) {
        if (name !== 'sidebar') return [];
        if (noPinControl) return [];
        return [{ options: { name: 'sidebar' }, inject: () => pinFace }];
      },
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

  return { definition, ctx, registered, documentElement, head, body, window, windowListeners, store, pins };
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

/**
 * A check that could not run on this machine (missing optional dependency, blocked syscall).
 *
 * It is neither `ok` nor `FAIL`: calling a blocked spawn "passed" hides the fact that nothing
 * was verified, and calling it "failed" makes the suite red for a reason the code cannot fix.
 * It still prints, so the count of assertions stays visible instead of quietly shrinking.
 */
function skip(name, reason) {
  console.log(`  skip ${name} -> ${reason}`);
}

/** Apply the plugin with the given settings and return the emitted stylesheet. */
async function emit(settingsOverride, extra) {
  const run = harness(settingsOverride, extra);
  const { definition, ctx, registered, documentElement, head, body, window, windowListeners, store, pins } = run;

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
    pins,
    tags,
    css: tags.length > 0 ? tags[0].textContent : '',
  };
}

async function main() {
  const base = await emit({});
  // `DSHBG_DUMP=1 node tools/smoke-test.cjs` 把几条带子的**线上真实规则**打出来。改玻璃配方时
  // 光看断言不够 —— 断言是「有没有」，这里是「长什么样」，后者是用户唯一能看见的东西。
  if (process.env.DSHBG_DUMP) {
    for (const key of [
      '[data-dshbg-head]',
      '[data-dockkit-strip]',
      '[data-textpreview-path]',
      '_compactionButton',
      'data-disclosure-header',
    ]) {
      const re = new RegExp('(\\[data-dshbg-on\\][^{]*' + key.replace(/[[\]]/g, '\\$&') + '[^{]*\\{[^}]*\\})', 'g');
      for (const m of base.css.match(re) || []) console.log('DUMP ' + m.replace(/\s+/g, ' '));
    }
  }
  console.log('module contract');
  check('module id matches package', base.definition && base.definition.id === MANIFEST.name, base.definition ? base.definition.id : 'no definition');
  // The bundle patch is a second, independent place where the package names itself — the
  // host resolves `name:` out of the profile's node_modules, so a stale literal here is a
  // plugin that simply never loads. It is a separate string from the module id, which is
  // exactly why renaming the package missed it once already.
  const PATCH = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  const patchNames = [...PATCH.matchAll(/^\s*name:\s*(.+)$/gm)].map((match) => match[1].trim().replace(/^['"]|['"]$/g, ''));
  check('the bundle patch names the package', patchNames.length === 1 && patchNames[0] === MANIFEST.name, patchNames.join(', '));
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

  console.log('\nduplicate uploads');
  // 判重靠「存下来的那份」的指纹，不是原文件字节 —— 照片是先重编码成 JPEG 再存的，原文件
  // 字节根本没留下，拿原文件去算会得到一个永远匹配不上任何东西的值。这条在 store-test 里
  // 有行为断言，这里只钉住入口没被拆掉、以及那个反直觉的取值来源没被「顺手优化」掉。
  check('an upload is fingerprinted before it is stored', CODE.includes('const digest = await digestOfIngested(ingested)'));
  check('and compared against what the gallery already holds', /record\.digest === digest/.test(CODE));
  check(
    'the fingerprint comes from the stored form, not from the picked file',
    /typeof ingested\.dataUrl === 'string'/.test(CODE) && /ingested\.blob\.arrayBuffer\(\)/.test(CODE),
  );
  check(
    'a refusal reaches the user as a message instead of looking like a failed upload',
    /code === 'duplicate'\) setError\(text\.duplicate\)/.test(CODE) &&
      CODE.includes("duplicate: '这个文件已经在图库里了") &&
      CODE.includes("duplicate: 'That file is already in the gallery"),
  );
  check(
    'and galleries saved before this existed get their fingerprints backfilled',
    CODE.includes('async function backfillDigests') && /typeof record\.digest !== 'string'/.test(CODE),
  );
  // 文件夹扫描：一次选整个目录，里面已经加过的不列出来。浏览器不给路径，也不给「重开上次
  // 那个文件」的权限，所以判重只能靠上传时记下的 name/size/mtime 三元组。
  check('a whole folder can be scanned instead of picking files one by one', CODE.includes('webkitdirectory'));
  check(
    'and the scan leaves out what the gallery already holds',
    /record\.source\.name\}\|\$\{record\.source\.size\}\|\$\{record\.source\.lastModified\}/.test(CODE),
  );
  check(
    'the scan reads that triple off the record, not off the file',
    /record\.source !== undefined && record\.source !== null/.test(CODE),
  );
  // 缩略图是 object URL，成批释放 —— 按格释放会把还在列表里的那张也弄空。
  check(
    'and its thumbnails are given back in a batch',
    /browseUrls\.current\.forEach\(\(url\) => window\.URL\.revokeObjectURL\(url\)\)/.test(CODE),
  );

  console.log('\nframing');
  // 取景位置必须同时落到 background-position 和 object-position 上，否则同一张照片和同一段
  // 视频会按两套不同的构图显示。
  const framed = await emit({ mode: 'image', imageId: CLIP.id, focusX: 20, focusY: 70 }, { images: [CLIP] });
  const framedBox = boxesOf(framed)[0];
  check('the still is cropped from the chosen point', framedBox.style.backgroundPosition === '20% 70%', framedBox.style.backgroundPosition);
  check('and so is the clip, from the same point', framedBox.children[0].style.objectPosition === '20% 70%', framedBox.children[0].style.objectPosition);
  check('the framing is per background, not global', CODE.includes("'focusX',") && CODE.includes("'focusY',"));
  check('and it is clamped to the box', /focusX: clamp\(pick\('focusX'\), 0, 100\)/.test(CODE) && /focusY: clamp\(pick\('focusY'\), 0, 100\)/.test(CODE));
  // `.dshbg-add` 是图库网格里的一格，带 `aspect-ratio: 16 / 10`。把它复用到普通按钮上，
  // 按钮会被拉成跟窗口一样高的虚线大框 —— 「居中」曾经就是这样变成 675px 的。测的是
  // 「这个按钮没有格子几何」，不是某个类名。
  check(
    'the recentre action is a plain button, not a gallery tile',
    /className: 'dshbg-plain'/.test(CODE) && !/className: 'dshbg-add'[\s\S]{0,120}text\.recenter/.test(CODE),
  );
  const plainRule = /\.dshbg-plain \{[^}]*\}/.exec(CODE);
  check('and its rule carries no tile geometry', plainRule !== null && !/aspect-ratio/.test(plainRule[0]), plainRule === null ? 'missing .dshbg-plain' : plainRule[0]);

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
  // 1.4.4 起输入卡**不再改写 `--dsw-specific-input-major`**。
  //
  // 那个 token 是继承的，而宿主的「计划待审」面板（`PlanReviewPanel` 的 `.card`）也写着
  // `background: var(--dsw-specific-input-major)` —— 把它改成半透明，改的就不是「这一张
  // 输入卡」，而是卡片里所有用这个 token 的东西，正文于是从计划卡底下透出来。
  // 现在只清这一张卡自己的底色，不透明度落在 `::after` 的底色板上。
  const composerRule = /html\[data-dshbg-on\] \[data-composer-card\]\s*\{([^}]*)\}/.exec(base.css);
  check('message box clears its own plate', composerRule !== null);
  if (composerRule !== null) {
    check(
      'and it uses a background rule, not the shared input token',
      /background: transparent/.test(composerRule[1]) &&
        !/--dsw-specific-input-major/.test(composerRule[1]),
      composerRule[1].trim().slice(0, 80),
    );
    check(
      'the input surface token is left alone for its other users',
      !/\[data-composer-card\][^{]*\{[^}]*--dsw-specific-input-major/.test(base.css),
    );
    check('composer override carries !important', /!important/.test(composerRule[1]));
  }
  const composerLow = await emit({ composerSurface: 30 });
  check(
    'composer opacity moves independently',
    composerLow.css.includes('var(--dshbg-raw-input) 30%, transparent'),
  );
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
      /\[data-composer-card\]::after \{[\s\S]{0,500}?var\(--dshbg-raw-input\) (\d+)%/,
    ) || [])[1],
  );
  check('the banner reads the composer fill', composerFill > 0 && bannerDefault.fill === composerFill);
  // 1.4.4 起输入卡不采样背景（搬壁纸），所以这里没有第二个 blur 可以和 banner 比 ——
  // 该钉住的是「它真的一个 backdrop-filter 都没有」，那正是「右栏一开磨砂就没了」
  // 和「打 / 之后输入区变透明」两个缺陷的共同根因。
  check(
    'the composer itself samples no backdrop at all',
    !/\[data-composer-card\] \{[^}]*backdrop-filter: blur/.test(glass.css),
  );
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
  // 「实心」这一档的判据是**不加模糊**，不是「一个 backdrop-filter 字样都不许有」：
  // `hostPanelCss` 会在宿主整页预览开着的时候显式写 `backdrop-filter: none` 把别人的模糊
  // 撤掉，那一条正是实心模式要的「平」，把它算成加料会把好人抓了。
  check('solid mode leaves the message box flat', !/\[data-composer-card\][^{]*\{[^}]*backdrop-filter:\s*blur/.test(base.css));
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
  // 输入框卡片：1.4.4 起走「搬壁纸」，不再采样背景。
  //
  // 历史：先是「模糊挂 ::before + isolation」（填充渲染、模糊从没上屏）→「元素自带
  // backdrop-filter，菜单打开时把它摘掉」（右栏一开磨砂就没了、打 `/` 时输入区变透明）
  // → 现在是 `::before` 画一份壁纸副本、`::after` 压一块底色板。两次失败共享同一个前提：
  // `backdrop-filter` 的结果取决于祖先链怎么合成，而输入卡周围的布局是会变的。
  const glassy = await emit({ composerStyle: 'glass' });
  check(
    'composer card paints the wallpaper itself',
    /\[data-composer-card\]::before \{[^}]*--dshbg-composer-x[\s\S]{0,1200}?background-image: var\(--dshbg-head-img/.test(
      glassy.css,
    ),
  );
  check(
    'and the copy is cut to the card own rounded box',
    /\[data-composer-card\]::before \{[^}]*clip-path: inset\([\s\S]{0,500}?round var\(--dshbg-composer-radius/.test(
      glassy.css,
    ),
  );
  check(
    'composer density comes from its own slider',
    (await emit({ composerStyle: 'glass', composerSurface: 40 })).css.includes(
      'var(--dshbg-raw-input) 40%, transparent',
    ),
  );
  check(
    'the plate sits in its own layer, not inside the copy filter',
    /\[data-composer-card\]::after \{[^}]*border-radius: inherit !important;[\s\S]{0,500}?linear-gradient/.test(
      glassy.css,
    ),
  );
  check('the menu trade-off is gone from the stylesheet', !/data-dshbg-menu/.test(glassy.css));
  check(
    'and so is the guard that used to mediate it',
    // 只钉函数本身：`[data-menu-material]` 仍是宿主菜单的合法标记，`menuSurfaceCss` 还在用它。
    !/function installComposerMenuGuard/.test(CODE),
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
  check('the dock reads the menu blur knob', dockBlur === '27', `dock ${dockBlur}`);
  // 1.4.4 起输入卡不采样背景，所以「和它同一个 blur」这句话不再成立 —— 反过来钉：
  // 它必须**没有** blur，否则「右栏一开磨砂就没了」会跟着回来。
  check(
    'while the message box has no blur to share any more',
    !cardBlur,
    `card ${cardBlur}`,
  );
  // 「回到最下面」那颗圆钮浮在正文上面，所以用比 pane 重的填充，并且要留住投影 ——
  // 换掉 box-shadow 就等于把宿主给的 --dsw-elevation-panel 弄丢了，它会看起来贴在纸上。
  check('jump-to-bottom disc is frosted', glass.css.includes('[class*="_toBottom"]:not([class*="_toBottomSlot"])'));
  check(
    'jump-to-bottom disc keeps its drop shadow',
    /_toBottomSlot"\]\)\s*\{[^}]*0 10px 30px -14px/.test(glass.css),
  );
  check('jump-to-bottom disc follows the finish switch', !/\[class\*="_toBottom"\][^{]*\{[^}]*backdrop-filter:\s*blur/.test(base.css));
  check('status row stays flat in solid mode', !/\[data-composer-dock\][^{]*\{[^}]*backdrop-filter:\s*blur/.test(base.css));
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

  console.log('\nsettings page title bar');
  // 那一栏在宿主里是**裸 `<div>`**：没有 `<header>`、没有 `role`、没有 `data-*`，类名还是
  // 构建 hash 的（`anW5wG_scrollBody` 这种）。没有名字可以指，所以插件在运行时量出那个
  // 盒子、打上 `data-dshbg-head`，样式只认这个标记。断言分两半：标记真的被写，规则真的
  // 只认标记 —— 少了任何一半，这条规则都会静默地什么都不匹配。
  check(
    'the title bar is marked at runtime, not guessed from a class name',
    /setAttribute\('data-dshbg-head', ''\)/.test(CODE) && /removeAttribute\('data-dshbg-head'\)/.test(CODE),
  );
  // 锚点是「真正能滚的那个盒子」，靠计算样式找：类名是构建 hash，而且每一页的滚动体根本
  // 不是同一个元素。上一版写死了 `_scrollBody`，在真正需要它的那一页上一个都没匹配上 ——
  // 因为那个名字本来就不是这一页的。
  check(
    'the scroller is found by computed style, never by a hashed class',
    /getComputedStyle\(node\)/.test(CODE) &&
      /overflowY === 'auto'/.test(CODE) &&
      !/querySelector(All)?\('\[class\*="_scrollBody"\]'\)/.test(CODE),
  );
  // 条子 = 与滚动体左右对齐、并且**跨在它上沿**的那一条。两条 contain 排除是安全线：
  // 包着滚动体的那一列如果加上 backdrop-filter，整页会变成一个 backdrop root，挂在它外面
  // 的菜单就再也采不到壁纸、静默丢掉模糊；而滚动体里的行更不该被糊。
  check(
    'the bar must straddle the scroller top edge, and be neither column nor row',
    /node\.contains\(body\)/.test(CODE) &&
      /body\.contains\(node\)/.test(CODE) &&
      /box\.top > area\.top/.test(CODE) &&
      /box\.bottom < area\.top/.test(CODE),
  );
  // 带子也可能**就住在滚动体里面**（`position: sticky`），那时它是滚动体的子元素 —— 光按
  // 「是不是滚动体的后代」一刀切会把它和列表行一起排掉。区分的是**在不在流里**：行是
  // `static`，带子不是。
  check(
    'a bar that is sticky inside the scroller is still recognised',
    /if \(body\.contains\(node\)\) \{/.test(CODE) && /pos !== 'sticky'/.test(CODE),
  );
  check(
    'the title bar style is keyed on that mark alone',
    /\[data-dshbg-head\]\s*\{/.test(base.css) && !/\[class\*="_header"\]/.test(base.css),
  );
  // ⚠️ 前缀只能是 `html[data-dshbg-on]`。挂到 `[data-dshbg-config]` 上是**错的** ——
  // 那个属性只有本插件自己的设置页会写，而这一栏在宿主的插件管理页上；用错前缀的结果
  // 是规则在样式表里、断言全绿、那一页一个像素都不变。
  check(
    'the title bar is scoped to the wallpaper being on, not to this plugin’s own page',
    /html\[data-dshbg-on\] \[data-dshbg-head\] \{/.test(base.css) &&
      !/\[data-dshbg-config\] \[data-dshbg-head\]/.test(base.css),
  );
  // ⚠️ 这一条是**范围**线，比配方更靠前：这条规则不是"加一层表面"，而是**拆掉宿主自己画的那
  // 一层**（`configHeadCss` 把 `::before` 清成透明）。所以标记一旦落错页面，那一页的表头不会
  // 变玻璃，而是**变空**。用户的原话：「你要改的是插件页面的那个表头，不是聊天的，工作区的，
  // 这两个的表头是好的」。
  //
  // 判据必须是**正面**的：插件页的 bar 会把 `--plugin-header-rest-height` 这类只属于它自己的
  // 变量写成**内联样式**（宿主 `attach()` 里 `bar.style.setProperty(...)`，全应用只有这一处会
  // 写这三个名字）。旧版用的是反面的 `isChat()` —— 去找 composer 卡片，找不到就认为"安全"，
  // 于是"工作区"这种没人想到过的页面全部中招。反面判断赢不了它没见过的那一页。
  check(
    'the bar is only ever the element carrying the plugin page’s own header variables',
    /const HEAD_VARS = \[/.test(CODE) &&
      /'--plugin-header-rest-height',/.test(CODE) &&
      /'--plugin-header-paint-height',/.test(CODE) &&
      /node\.style\.getPropertyValue\(HEAD_VARS\[i\]\) !== ''/.test(CODE) &&
      /const head = candidate === null \? null : barOf\(candidate\);/.test(CODE) &&
      /found = found\.parentElement;/.test(CODE),
  );
  // 反面：不许再出现"靠认页面来排除"的写法。`isChat` 一旦回来，就等于又给"落错页面"开了一道
  // 门；而 `[data-composer-card]` 本身在别处是合法的（消息框玻璃），所以只钉这个名字。
  // ⚠️ 只钉**定义**和**调用**，不钉这个裸名字 —— client.js 的注释里要解释为什么删掉它，那行
  // 注释会让裸名字一直命中，然后这条断言就永远假设"已经改回来了"。
  check(
    'the mark is not gated on recognising which page it is instead',
    !/const isChat = \(\) =>/.test(CODE) && !/\|\| isChat\(\)/.test(CODE),
  );
  // 关系选择器兜底删掉了。它在真正需要它的那一页上匹配零个元素，而断言全绿 —— 这种"兜底"
  // 读起来像覆盖，实际只覆盖四种形状里的一种，还可能糊掉整列。现在样式表里只认那一个标记。
  check(
    'no relationship fallback is left to fire on the wrong element',
    !/_scrollBody/.test(base.css) && (base.css.match(/\[data-dshbg-head\]\s*\{/g) || []).length === 1,
  );
  // 条子有可能被宿主画在行**下面**（行有自己的 z-index）—— 那时磨砂藏在它该盖住的文字底下，
  // 屏幕上和"没改"一模一样。命中测试找不到就按树找，找到后只在 position 早已不是 static、
  // z-index 还是 auto 时抬一层：宿主自己设定的层级是故意的，不动。
  check(
    'an overlapping bar is lifted above the rows it has to hide',
    /style\.position === 'static' \|\| style\.zIndex !== 'auto'/.test(CODE) &&
      /style\.zIndex = '4'/.test(CODE),
  );
  check('the locator can be asked what it found', /window\.__dshbgHead = report;/.test(CODE));
  // A/B 开关：`__dshbgHeadGlass(false)` 要能在不重启的情况下把这块还给宿主 —— 拿掉标记就够，
  // 因为这条链上**所有**规则都 keyed on `[data-dshbg-head]`。断言两件事：开关存在，且
  // `sync()` 在最前面就处理它（放在 `data-dshbg-on` 判断之后的话，壁纸关掉时会被跳过）。
  check(
    'the treatment can be parked and resumed without a restart',
    /window\.__dshbgHeadGlass = \(on\) => \{[\s\S]{0,320}?suspended = on === false;/.test(CODE) &&
      /const sync = \(\) => \{\s*if \(disposed\) return;[\s\S]{0,700}?if \(suspended\) \{\s*unmark\(\);\s*unmarkLids\(\);\s*return;/.test(CODE),
  );
  // ⚠️ 1.3.31：这条原来是反的（「the title bar frosts the rows that scroll under it」）。
  // 它守的是 1.3.30 的 `blur(32px)`，而那一版在屏幕上正是用户说的「还是有模糊」—— 壁纸已经
  // 被 `paintWall()` 糊过一遍，表头再叠一次就比肩上肩的地方更糊。现在要求的是**一次都不糊**，
  // 而且要把 `none` 显式写出来（宿主若给自己的表头加滤镜，这条能兜住）。
  check(
    'the title bar adds no second blur: the wallpaper is already blurred at the source',
    /\[data-dshbg-headwall\] \{[^}]*backdrop-filter: none !important/.test(base.css),
  );
  // ⚠️ 这条带子是**有**填充的，而且那个数就是侧栏那条滑杆本身 —— 具体见下面几条。
  // 反面的一半：不许是渐变。渐变把底边归零，滚上来的行在带子下半截就会裸着露出来，
  // 而那正是「没有覆盖，非常清晰」的形状。
  check(
    'the bar does not fade out, which would leave the rows bare at its bottom',
    !/\[data-dshbg-head\] \{[^}]*background: linear-gradient/.test(base.css),
  );
  const barBody = (/\[data-dshbg-head\] \{([^}]*)\}/.exec(base.css) || ['', ''])[1];
  const marketBody = (/\[class\$="_stickyHead"\] \{([^}]*)\}/.exec(base.css) || ['', ''])[1];
  const barOf = (css) => (/\[data-dshbg-head\] \{([^}]*)\}/.exec(css) || ['', ''])[1];
  // 1.3.27：玻璃已经挪到伪元素上（宿主那个底色板），所以「填充/模糊」类的断言要看
  // `::before`，而「不许有描边/饱和」仍然看 bar 本体 —— 两者分开，才不会一条断言兼管两件事。
  //
  // ⚠️ 1.3.33：`::before` 不再独吞这套几何 —— 视频壁纸要放一颗真的 `<video>`，伪元素装不下，
  // 于是多了一个 `[data-dshbg-headwall]` 元素，两条选择器**共用同一条规则**（同一个盒子，
  // 同一份 `clip-path`）。所以这里取的是规则体，不是某一个选择器的体：两个选择器必须给出一模一样
  // 的盒子，否则「视频走一条路、图片走另一条路」就会各长一个样。
  const frostOf = (css) => {
    const hit = /\[data-dshbg-head\]::before,\s*\nhtml\[data-dshbg-on\] \[data-dshbg-head\] > \[data-dshbg-headwall\] \{([^}]*)\}/.exec(css);
    if (hit !== null) return hit[1];
    return (/\[data-dshbg-head\]::before \{([^}]*)\}/.exec(css) || ['', ''])[1];
  };
  const bandOf = (css) => barOf(css) + frostOf(css);
  // ⚠️ 必须显式 `fullWindow: true`：默认设置下这块玻璃是关的（退回 `STICKY_FILL`），
  // 拿 `base.css` 里的正文去断言只会读到那条退路。
  const headFull = bandOf((await emit({ fullWindow: true })).css);
  // ⚠️ 1.3.30：这一格先后钉过四个数 —— `sidebarFill` 40 / `surface` 50 / `PANE_FILL` 22 /
  // 干脆一个都没有、只留 `brightness(.94)`。四次的错法不同、错因是同一个：**它一直假设这块
  // 表面该自己长一个样**。
  //
  // 用户两句话把结论说完了：先「调成一样的数值磨砂很难吗」，再「**在这里不要使用磨砂，这里
  // 就是模糊**」。所以这条带子的目标不是「另一种磨砂」，而是**只要模糊**：
  // 另外两条带子（标签栏、文档路径条）浮在内容上，需要一层膜把它们和底下的字隔开；这条是
  // 页面自己的表头，底下滑过的就是同一张壁纸，只需要把字糊掉。填充、饱和、压暗三个都不该有。
  check(
    "the host's own backdrop on the bar is taken over, not left above the glass",
    !/\[data-dshbg-head\]::before \{[^}]*background: var\(--dsw-alias-bg-base\)/.test(base.css) &&
      /background-color: transparent !important/.test(headFull),
  );
  // 只取 `::before` 里那三行玻璃声明，几何行不算 —— 表头多一行 `height: 100%`（宿主的
  // `paint-height` 只有半个头高，折叠动画要用），那是它自己的活，不是材质。
  const declsOf = (body) =>
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(background|-webkit-backdrop-filter|backdrop-filter)/.test(line))
      .join('\n');
  const stripFrost = declsOf(
    (/\[data-dockkit-strip\]::before \{([^}]*)\}/.exec(base.css) || ['', ''])[1],
  );
  const headFrost = declsOf(
    (/\[data-dshbg-head\]::before \{([^}]*)\}/.exec(base.css) || ['', ''])[1],
  );
  // ⚠️ 1.3.32：这一格的锚点变了。1.3.30/1.3.31 问的是「这条带子上还有什么」，现在问的是
  // 「它和壁纸那一套对不对得上」—— 因为表头挂的是**壁纸的同源副本**，不是另一种材质。
  //
  // 为什么不能是 `backdrop-filter`：壁纸已经被 `paintWall()` 用滑杆糊过 F，表头再叠 N 就是
  // √(F²+N²)，永远大于周围；N=0 又等于不挡。用户那句「和周围的模糊的所有效果一致」在
  // `backdrop-filter` 上无解，唯一的解是把那批像素搬过来。
  const headBefore = frostOf(base.css);
  check(
    'the bar paints the wallpaper itself instead of a material',
    /background-image: var\(--dshbg-head-img, none\) !important/.test(headBefore) &&
      /background-size: cover !important/.test(headBefore) &&
      /filter: var\(--dshbg-head-filter, none\) !important/.test(headBefore),
  );
  // 副本是一个**整屏大小**的盒子（`cover` 必须按壁纸那个盒来缩放），所以它一定得裁，
  // 不裁就盖住整个页面。裁到宿主自己算出来的 `paint-height`，折叠动画才跟得上。
  check(
    'the copy is cut down to the bar',
    /clip-path: inset\(/.test(headBefore) &&
      /var\(--plugin-header-paint-height, var\(--plugin-header-rest-height/.test(headBefore),
  );
  // 三套数逐字对上：溢出量、滤镜串、定位来源。任何一项漂了，表头那块就不是壁纸的同一些像素。
  //
  // 这些数**不在样式表里**（图是几百 KB 的 data URL，进 `<style>` 会让 `paint()` 每帧重建、
  // 比较它），所以只能从 `setWall()` 那个出口读回来 —— 这也正是线上真正生效的那一份。
  const wallVarsFor = async (override) => {
    const run = await emit(override);
    const probe = run.window.__dshbgHead;
    return typeof probe === 'function' ? probe().wall : null;
  };
  const vars20 = await wallVarsFor({ blur: 20, dim: 0 });
  const css20 = (await emit({ blur: 20, dim: 0 })).css;
  const stack20 = (/\[data-dshbg-stack\] \{([^}]*)\}/.exec(css20) || ['', ''])[1];
  check(
    "the copy lands on the wallpaper's own box",
    vars20 !== null &&
      vars20.bleed === '52px' &&
      stack20.includes('top: -52px') &&
      stack20.includes('width: calc(100vw + 104px)'),
    JSON.stringify(vars20),
  );
  const varsDim = await wallVarsFor({ blur: 20, dim: 10 });
  check(
    'the copy takes the exact filter string the wallpaper was painted with',
    vars20 !== null &&
      vars20.filter === 'blur(20px)' &&
      varsDim !== null &&
      varsDim.filter === 'blur(20px) brightness(0.900)',
    vars20 === null ? 'no wall vars' : vars20.filter,
  );
  check(
    "the copy is placed by the bar's own box, not by the viewport",
    /var\(--dshbg-head-x/.test(headBefore) && /var\(--dshbg-head-w/.test(headBefore),
  );
  // ⚠️ 1.3.33：**视频壁纸。** `wall.value` 对它是封面，只贴封面 = 「周围在放、这里定住」，
  // 用户的一句话就是「怎么还会变的」。所以这一类还必须多一份**会动的**副本，封面退成地板。
  const clipHeadRun = await emit({ mode: 'image', imageId: CLIP.id }, { images: [CLIP] });
  const clipHead = clipHeadRun.window.__dshbgHead();
  check(
    'a clip wallpaper keeps its poster as the floor of the copy',
    clipHead.wall !== null && clipHead.wall.img === 'url("data:clip-poster")',
    JSON.stringify(clipHead.wall),
  );
  check(
    'and gets a live copy on top, because a poster cannot follow a playing clip',
    clipHead.video !== null &&
      /\[data-dshbg-head\] > \[data-dshbg-headwall\] > video \{/.test(clipHeadRun.css),
    JSON.stringify(clipHead.video),
  );
  // 副本要有「跟住」的机制，而且不能每帧 seek：`currentTime` 的写会丢掉一个关键帧，
  // 每帧都写等于每帧卡一下。阈值 + `requestVideoFrameCallback` 两样一起钉。
  check(
    'the live copy is frame-locked to the master clip, with a seek threshold',
    /requestVideoFrameCallback/.test(CODE) &&
      /const drift = mediaVideo\.currentTime - main\.currentTime;/.test(CODE) &&
      /if \(drift > 0\.06 \|\| drift < -0\.06\) mediaVideo\.currentTime = main\.currentTime;/.test(CODE),
  );
  check(
    'the copy sits on the same box as the still path, not on one of its own',
    /\[data-dshbg-head\]::before,\s*\nhtml\[data-dshbg-on\] \[data-dshbg-head\] > \[data-dshbg-headwall\] \{/.test(headBefore === '' ? '' : clipHeadRun.css),
  );
  check(
    'reduced motion builds no live copy at all',
    (await emit({ mode: 'image', imageId: CLIP.id }, { images: [CLIP], reducedMotion: true }))
      .window.__dshbgHead().video === null,
  );
  check(
    'a still wallpaper builds no live copy either',
    vars20 !== null && vars20.img !== 'none',
  );
  check(
    'the bar carries no saturate: this is the wallpaper, not frost',
    !/saturate/.test(headFrost) && !/saturate/.test(barBody),
  );
  check(
    'no backdrop-filter is left on the bar',
    headFrost.split('\n').filter((line) => /backdrop-filter/.test(line)).every((line) => /: none !important;$/.test(line)),
  );
  // 表头**不许自己上第二道模糊**。这条防的是退回到 1.3.30：给副本再叠 `blur()`，糊就被
  // 施加了两遍，`cover` 再怎么对齐也救不回来。
  check(
    'the bar does not re-blur what the wallpaper already blurred',
    !/backdrop-filter: (?!none)/.test(headFull) && !/blur\(\d/.test(headBefore),
  );  // 玻璃挂在伪元素上，**不挂在 bar 上**：`backdrop-filter` 会建包含块，bar 里那些不带
  // `portal` 的 fixed tooltip 会整体挪位（`frostedBandCss` 那边实测过 100px 的偏移）。
  // ⚠️ 1.3.31：这一条从「模糊只能在伪元素上」升级成「两处都不许有真滤镜」—— 没有滤镜就
  // 没有包含块，bar 里那些 fixed tooltip 连偏移的机会都没有。
  check(
    'no real filter anywhere on the bar, so nothing becomes a containing block',
    !/backdrop-filter: (?!none)/.test(headFull),
  );
  // ⚠️ 1.3.30 删掉的两条：「the bar carries no alpha tint at all」和「the dimming is
  // multiplicative」。它们是 1.3.29 为「零填充 + brightness(0.94)」量身做的，而那一版已经
  // 作废 —— 它把这条带子做成了全应用唯一一块**没有填充、只压暗**的玻璃，于是它和身边每一条
  // 带子都不一样。留着这两条只会保证「继续不一样」。取代它们的是上面那条逐字相同。
  //
  // 反面：三条滑杆都不许把它推回「一块板」。`surface` 那条是 1.3.26 的错，`sidebarFill` 是
  // 1.3.25 的；两边各取相差 70 点的两端，输出必须逐字相同。
  const headBar = headFull;
  check(
    'no slider can turn the bar back into a slab',
    bandOf((await emit({ fullWindow: true, sidebarFill: 20 })).css) === headBar &&
      bandOf((await emit({ fullWindow: true, sidebarFill: 80 })).css) === headBar &&
      bandOf((await emit({ fullWindow: true, surface: 10 })).css) === headBar &&
      bandOf((await emit({ fullWindow: true, surface: 90 })).css) === headBar,
  );
  // 没有壁纸铺满窗口时也是同样的处理：纯模糊在没有壁纸时本来就是空转（底下是实心），
  // 所以**不需要**一条退路 —— 有退路反而意味着「开不开壁纸是两种材质」。
  check(
    'the bar is blurred the same way whether or not the wallpaper fills the window',
    bandOf((await emit({ fullWindow: false })).css) === headBar,
  );
  // ⚠️ 1.3.32：这条原来是「它不该有配方可共享」（1.3.31 的答案）。现在反过来，而且更严 ——
  // 它共享的不是某条带子的磨砂配方，而是**壁纸本身的参数**：溢出量、图、位置、滤镜。
  // `bleedOf(layer)` 和 `reducedMotion()` 必须来自壁纸那一侧，不许在这里另算一个数；
  // 任何写死的像素值（`blur(32px)` 这种）都会让「和周围一致」当场失效。
  const wallVarsSource = (/function headWallVars[\s\S]*?\n    \}\n/.exec(CODE) || [''])[0];
  const configHeadSource = (/function configHeadCss[\s\S]*?\n    \}\n/.exec(CODE) || [''])[0];
  check(
    "the bar shares the wallpaper's parameters instead of inventing its own",
    wallVarsSource.length > 0 &&
      /bleedOf\(layer\)/.test(wallVarsSource) &&
      /reducedMotion\(\)/.test(wallVarsSource) &&
      /wall\.dim === 0/.test(wallVarsSource) &&
      !/blur\(\d/.test(wallVarsSource) &&
      // 样式表那一侧一个数都不许有 —— 有就是「另长一个样」的开头，而且那个数会和壁纸漂开。
      configHeadSource.length > 0 &&
      !/color-mix|saturate/.test(configHeadSource) &&
      !/blur\(\d/.test(configHeadSource),
  );
  // 市场页那条吸顶栏是另一回事：它的底色就在自己身上，所以继续用那条共享薄填充。
  check(
    'the market header keeps its own thin fill',
    marketBody.includes('var(--dshbg-raw-base) 8%, transparent'),
  );
  // 反面的一半：**不许**有 pane 的四面内环和投影。少了这条，改回 `glassPane()` 也会绿。
  // 另外**不许**自带描边：宿主 `.pageBar[data-natural][data-compact]:after` 已经画了一条
  // `border-bottom: .5px solid var(--dsw-alias-border-l3)`，我们再叠一条就是双线。
  check(
    'a bar that content scrolls under gets blur, not a raised card',
    !/inset 0 0 0 1px/.test(barBody) && !/0 10px 30px/.test(barBody) && !/inset 0 -?1px/.test(barBody),
  );
  // 侧面确认另外两条带子**仍然**是磨砂（8% + saturate）：这条断言防的是「为了表头好看，
  // 把三条带子一起拆了」—— 标签栏和路径条浮在内容上，它们那层膜是必需的。
  check(
    'the other two bars keep their frost while this one has nothing on it',
    /saturate\(150%\)/.test(stripFrost) &&
      /color-mix\(in srgb, var\(--dshbg-raw-base\) 8%, transparent\)/.test(stripFrost),
  );
  // ⚠️ 1.3.31：这里原来钉的是 `stickyHeadRecipe` 的三条边（×2 / 32 下限 / 64 上限）。
  // 现在这条带子上根本没有滤镜，所以那三条边**不该**再对它有任何影响 —— 把 menu 模糊推到
  // 两端、把壁纸滑杆推到两端，输出必须逐字相同，而且里面不许出现 `blur(`。
  const barsUnder = await Promise.all(
    [
      { blur: 3, menuBlur: 1 },
      { blur: 40, menuBlur: 4 },
      { blur: 7, menuBlur: 20 },
      { blur: 17, menuBlur: 77 },
      { blur: 0, menuBlur: 500 },
    ].map(async (s) => bandOf((await emit(s)).css)),
  );
  check(
    'no menu-blur or wallpaper value can put a filter back on the bar',
    barsUnder.every((css) => !/blur\(/.test(css)) && barsUnder.every((css) => css === barsUnder[0]),
  );
  // 每多一个 `backdrop-filter` 就多一次每帧取快照（档案第 18 条）。这一处是例外——它
  // 底下滑过的是**没模糊过的文字**，快照在做实事——但例外只能有一个：不能再往条子内部糊
  // 第二层，那只是给已经糊过的东西再买一张纹理。
  check(
    'nothing inside the bar is frosted a second time',
    (base.css.match(/html\[data-dshbg-on\] \[data-dshbg-head\][^{]*\{[^}]*\}/g) || [])
      .every((rule) => !/backdrop-filter:(?!\s*none)/.test(rule)),
  );

  console.log('\nsticky lids (compaction + reasoning)');
  // 吸顶盖：展开之后变 `sticky` 的窄头，正文会从它底下滚过去。1.3.37 / 1.3.38 两版都用
  // `backdrop-filter`，而那个方案**看起来就是一块比周围亮的板**（糊的是正文，字是亮的）。
  // 1.3.39 换成和插件页表头同一套：把壁纸那批像素搬到盖子上。
  const lidReset = (/html\[data-dshbg-on\] \[data-dshbg-lid\] \{([^}]*)\}/.exec(base.css) || ['', ''])[1];
  const lidCopy = (/html\[data-dshbg-on\] \[data-dshbg-lid\]::before \{([^}]*)\}/.exec(base.css) || ['', ''])[1];
  const lidPlate = (/html\[data-dshbg-on\] \[data-dshbg-lid\]::after \{([^}]*)\}/.exec(base.css) || ['', ''])[1];

  check('the lid is styled through a mark the plugin owns', lidReset !== '' && lidCopy !== '');
  // 宿主那两种写法（尾缀类名 / `data-*`）形状完全不同，所以「怎么找到」留在 JS 里；
  // CSS 只认我们打上去的标记。这条钉住的是：规则里不许再出现任何宿主选择器。
  check(
    'and the rules carry no host selector - finding the lid is the finder’s job',
    !/_compaction|data-disclosure-header|data-expanded/.test(
      base.css.match(/html\[data-dshbg-on\] \[data-dshbg-lid\][^{]*\{[^}]*\}/g) || [''],
    ),
  );
  check(
    'the finder knows both host shapes',
    /\[class\$="_compactionRow"\]:has\(\[class\$="_compactionBody"\]\) \[class\$="_compactionButton"\]/.test(CODE) &&
      /\[data-expanded\] \[data-open\] > \[data-disclosure-header\]/.test(CODE),
  );
  // ⚠️ 只收真的 `sticky` 的：副本按「元素在视口里的坐标」反推位置，收起态的标题既不吸顶
  // 也不压着任何东西，继续画一份壁纸只是白花钱，还会在展开动画里跟着抖。
  check('only lids that are actually stuck get a copy', /position !== 'sticky'/.test(CODE));
  // 这一条是整套方案的**核心**：盖子上画的是壁纸本身（同图、同取景、同滤镜串），
  // 不是任何一种「材质」。少任何一个，它就会重新变成一块看得出来的板。
  check(
    'the lid paints the wallpaper itself instead of a material',
    /background-image: var\(--dshbg-head-img, none\) !important/.test(lidCopy) &&
      /background-size: cover !important/.test(lidCopy) &&
      /filter: var\(--dshbg-head-filter, none\) !important/.test(lidCopy) &&
      /backdrop-filter: none !important/.test(lidCopy),
  );
  // 裁到**盖子自己**的高度，不是表头那个 `--plugin-header-paint-height`：两者高度不同，
  // 用错了会裁出一条比盖子高一截或矮一截的带子。
  check(
    'the copy is cut down to the lid’s own height',
    /var\(--dshbg-lid-h, 24px\)/.test(lidCopy) && !/plugin-header-paint-height/.test(lidCopy),
  );
  // 多出来的那一层：对话面板本身压着 `--dsw-alias-bg-base`（半透明），「周围」的颜色是
  // 「壁纸 × 面板底色」。缺这一层，盖子上会亮 1.66 倍（实测 Δ 均值 60）。
  check(
    'the chat’s own plate is reproduced, or the lid would be 1.66x too bright',
    /background: var\(--dsw-alias-bg-base, transparent\) !important/.test(lidPlate) &&
      /inset: 0 !important/.test(lidPlate),
  );
  // 而且它必须是一层**独立的**东西：塞进 `::before` 的 `background-image` 里等于把底色
  // 卷进了滤镜（`blur(色 over 图)` ≠ `色 over blur(图)`，合成不是线性的），残余 Δ 还有 1.8。
  check(
    'and that plate sits outside the blur, not inside its background stack',
    !/linear-gradient\(var\(--dsw-alias-bg-base/.test(lidCopy),
  );
  // 只许改画法：`position` 一改就不吸顶（`frostedBandCss()` 那种 `relative` 就是这么把盖子
  // 拆掉的），`z-index` 宿主写死 7 / 1，我们要么一样要么更小。
  check(
    'and it changes nothing but the paint',
    !/position:/.test(lidReset) && !/z-index/.test(lidReset),
    lidReset.replace(/\s+/g, ' ').slice(0, 120),
  );
  // 盖子收起、或者被 React 换成别的节点时必须把自己擦干净：留着标记就是一个
  // 「已经不吸顶了还在画壁纸」的元素，屏幕上是一块贴错位置的色块。
  check(
    'a lid that stops being a lid is cleaned up, not left painting a wallpaper',
    /const stripLid = \(node\) => \{[\s\S]{0,200}?node\.removeAttribute\('data-dshbg-lid'\)/.test(CODE) &&
      /keep\.indexOf\(lidNodes\[i\]\) === -1\) stripLid/.test(CODE),
  );
  // 壁纸那四个数写在 `<html>` 上：表头和盖子不是父子关系，各写一份等于把几百 KB 的
  // `data:` URL 存两遍，而它们要的本来就是同一张图。
  check(
    'both surfaces share one copy of the wallpaper, written on the root',
    /root\.style\.setProperty\(HEAD_WALL_VARS\[i\]/.test(CODE) &&
      !/marked\.style\.setProperty\(HEAD_WALL_VARS\[i\]/.test(CODE),
  );
  // Whole-window scope: the sidebar is glass there, so the opaque page must cover it too
  // or the page sits beside a see-through strip.
  const wideConfig = /html\[data-dshbg-on\]\[data-dshbg-config\][^{},]*div:has\(> \[data-shell-overlay\]\)\s*\{/.test(wide.css);
  const wideConfigStillColumnar = /html\[data-dshbg-on\]\[data-dshbg-config\][^{}]*nth-of-type/.test(wide.css);
  check('whole-window scope covers the sidebar as well', wideConfig && !wideConfigStillColumnar);

  console.log('\ndocument preview header');
  // 预览面板的表头（`.preview` column flex + `.header{flex:none;height:38px}` + `.content{flex:auto}`）
  // 是正常流里的 chrome：文档在它下面自己滚，永不从它底下过，也没有东西从它背后滚过去。
  //
  // ⚠️ 1.3.25 之前这里的断言是**反面**的：「本插件的样式表里不许出现这个锚点」。理由是两次
  // 失败：60% 填充变成「贴在文档上的深色横杠」；换成透明 + `backdrop-filter` 之后，**这一行
  // 自己的 12px 路径变成双影**（同一串路径画了两遍、差几个像素、都是满亮度，所以不是「背后
  // 透出来的」）。宿主 `PathLabel` 的 `_path` 带 `mask-image`
  // （`._path_1kiio_3[data-path-clipped]{mask-image:linear-gradient(to right,transparent,black 28px)}`），
  // 而带 mask 的子树嵌在一个**自带 `backdrop-filter` 的元素里**，正是 Chromium 会重复合成的那一对。
  //
  // 1.3.25 换了挂法：模糊挂 `::before`（叶子），表头自己**不**带 `backdrop-filter` ——
  // 带 mask 的路径因此不在任何 backdrop-filter 元素**里面**，那一对就凑不齐了。用户这一轮
  // 要的就是这两行有底色（「在侧边栏展示文件的这两行加上背景磨砂」），所以约束从「别碰」改成
  // 「怎么碰」：锚点在、但模糊只能在伪元素上。
  const headSkin = /:has\(> \[data-textpreview-path\]\)::before \{[^}]*\}/.exec(base.css)?.[0] ?? '';
  check(
    'the file path bar gets a surface of its own',
    headSkin.includes('backdrop-filter: blur(') && headSkin.includes('color-mix'),
  );
  // 宿主 `_path` 带 `mask-image`，带 mask 的子树嵌进一个自带 `backdrop-filter` 的元素
  // 就会被 Chromium 重复合成（1.3.18 的双影）。这里逐条把「提到路径条的选择器」过一遍：
  // 除了 `::before` 那一条，任何一条都不许自己带模糊。
  const pathRules = [...base.css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
    m[1].includes('data-textpreview-path'),
  );
  const pathCarriesFilter = pathRules.some(
    (m) => !m[1].includes('::before') && m[2].includes('backdrop-filter'),
  );
  check(
    'and the masked path never ends up inside a backdrop-filter element - that is what doubled it',
    pathRules.length > 0 && !pathCarriesFilter,
  );
  // 反面：不许顺手把这个面板的正文也糊上（正文里是代码，逐帧重栅格化没有收益）。
  check('the preview body is left alone', !/data-textpreview-content\s*[^{]*\{[^}]*backdrop-filter/.test(base.css));

  // ------------------------------------------------------------------ 层叠
  //
  // 一页文档铺满窗口时，「谁在上面」不能取决于谁碰巧是合成层。用户 11-10 的截图：白纸
  // 文档上飘着一条「代码块」表头、一张文件卡、一个输入框 —— 它们全是中间那一列里自带
  // 合成层的零件（模糊 + 宿主的 `z-index: 6`），而列自己什么都不建，于是它们的层被提到
  // 帧里去排。下面三条钉的就是这个现场，量的是**规则在不在**和**模糊有没有被撤**。
  console.log('\nstacking order');
  check(
    'the conversation column is a layer of its own',
    /html\[data-dshbg-on\][^{]*> div:nth-of-type\(2\) \{[^}]*isolation: isolate/.test(base.css),
  );
  // 它是层叠上下文，**不是** backdrop root：`isolation` 不建背景根，玻璃的模糊一点不变，
  // 也不多买一张每帧快照。这条是防止有人「顺手」把它换成 filter / backdrop-filter。
  check(
    'and it is isolated without becoming a backdrop root',
    !/nth-of-type\(2\) \{[^}]*(?:filter:|backdrop-filter:)/.test(base.css),
  );
  const panelRule = (() => {
    const at = base.css.indexOf('data-dshbg-panel');
    if (at < 0) return '';
    const open = base.css.lastIndexOf('{', at + 400);
    return base.css.slice(base.css.lastIndexOf('\n', at - 200) < 0 ? 0 : base.css.lastIndexOf('\n', at - 200), base.css.indexOf('}', at) + 1);
  })();
  check('a host document preview has a rule of its own', panelRule.length > 0);
  // 五个模糊点一个都不能漏：漏掉的那个就是屏幕上还飘着的那一件。
  const frostSites = [
    '[data-composer-card]',
    '[data-composer-dock]',
    '[data-sidebar-right-panel]',
    '[class*="_bannerWrap"]',
    '[class*="_toBottom"]:not([class*="_toBottomSlot"])',
  ];
  check(
    'every plugin frost yields while a document preview owns the window',
    frostSites.every((site) => base.css.includes(`[data-dshbg-panel] ${site}`)),
  );
  check(
    'the yielded rule only ever turns blur off, never on',
    /\[data-dshbg-panel\][^{]*\{[^}]*backdrop-filter: none/.test(base.css) &&
      !/\[data-dshbg-panel\][^{]*\{[^}]*backdrop-filter:\s*(?:blur|saturate)/.test(base.css),
  );
  // 面板自己装着预览时也不许糊：带 mask 的路径条嵌在 backdrop root 里会被重复合成一遍。
  const previewPanel = (await emit({ menuFill: 30 })).css;
  check(
    'a panel holding a preview is not frosted, only filled',
    /:has\(\[data-document-preview\]\)[^{]*\{[^}]*backdrop-filter: none/.test(previewPanel) &&
      /:has\(\[data-document-preview\]\)[^{]*\{[^}]*background: color-mix/.test(previewPanel),
  );
  check(
    'and its fill is a step denser than the plain panel',
    (() => {
      const plain = /\[data-sidebar-right-panel\]\[data-sidebar-right-open\] \{[^}]*var\(--dshbg-raw-l1\) (\d+)%/.exec(previewPanel);
      const held = /:has\(\[data-document-preview\]\)[^{]*\{[^}]*var\(--dshbg-raw-l1\) (\d+)%/.exec(previewPanel);
      return plain !== null && held !== null && Number(held[1]) > Number(plain[1]);
    })(),
  );
  check('the panel is isolated so nothing inside it escapes', /:has\(\[data-document-preview\]\)[^{]*\{[^}]*isolation: isolate/.test(previewPanel));
  // 守卫本身：写标记 / 撤标记 / 只在插件启用时写 / 防抖。
  const guardCode = CODE.slice(
    CODE.indexOf('function installHostPanelGuard('),
    CODE.indexOf('const STACK_SELECTOR'),
  );
  check('the panel guard writes its marker', guardCode.includes("setAttribute('data-dshbg-panel', '')"));
  check('the panel guard clears the marker again', guardCode.includes("removeAttribute('data-dshbg-panel')"));
  check('the marker never survives the plugin being off', /!root\.hasAttribute\('data-dshbg-on'\)[\s\S]{0,120}removeAttribute\('data-dshbg-panel'\)/.test(guardCode));
  check('the guard is debounced like the menu guard', guardCode.includes('setTimeout(sync, 120)'));
  check('the guard is wired into paint and dispose', CODE.includes('hostPanel.sync();') && CODE.includes('hostPanel.dispose();'));


  console.log('\nquestion card + dock strip');
  // 提问工具的「已答」回执。它借的是用户气泡，但 flow kind 是 `question-reply`，
  // 上面那三条 flow 规则一条都不沾，所以只能靠宿主给的 `data-question-reply` 认。
  check(
    'an answered question card becomes a pane',
    base.css.includes('[data-question-reply] [class*="_bubble"]'),
  );
  check(
    'and it is on the same 22% pane recipe as the user bubble',
    /\[data-question-reply\] \[class\*="_bubble"\][^{]*\{[^}]*22%/.test(base.css),
  );
  // 1.3.24：这张卡的 DOM 是 `_row > _bubbleWidth > _bubble`，而 `[class*="_bubble"]` 是
  // **子串**匹配 —— `BfLV8a_bubbleWidth` 里含 `_bubble`，会被一起画上。那个壳没有圆角、
  // 尺寸却和气泡一模一样，于是同一圈描边一次画成弧、一次画成直角（用户截图里的方框）。
  check(
    'the width shell around the bubble is not painted',
    base.css.includes('[data-question-reply] [class*="_bubble"]:not([class*="_bubbleWidth"])'),
  );
  check(
    'so the pane lands exactly once - a second ring on a square shell costs a right angle',
    !/\[data-question-reply\] \[class\*="_bubble"\]\s*[,{]/.test(base.css),
  );
  // 标签栏：`_tab` 自己没有 overflow，唯一裁字的是标题；标题的 mask 是「重复合成一遍」
  // 的开关（1.3.18 的路径条同一个病），所以裁切下沉到标签、mask 摘掉。
  check('the tab clips its own title', /\[data-dockkit-tab\] \{[^}]*overflow: clip/.test(base.css));
  check(
    'the tab title loses the fade mask',
    /\[data-dockkit-tab-title\] \{[^}]*(?:-webkit-)?mask-image: none/.test(base.css),
  );
  check(
    'but the strip keeps its own mask - it is the only "more tabs" hint',
    !/\[data-dockkit-strip-tabs\][^{]*\{[^}]*mask-image: none/.test(base.css),
  );
  // 1.3.22：整条标签栏自己磨一层。宿主这条带子**一个底色都没有**，一直靠下面 pane 的
  // `--dsw-alias-bg-base` 当底；那个 token 被我们改成半透明之后，压在底下的**别的面板
  // 的标题栏**就从标签栏里透出来了（用户截图里那句「团队 ▸ AI 业务模式」）。
  //
  // 断言的是三条性质，不是写法：①底下是字，所以必须有模糊（只加填充是治标）；②填充
  // 必须是半透明的（整条不透明就是一档更深的横带，又是一道缝）；③模糊必须走
  // `stickyHeadRecipe`，跟着 `menuBlur` 走到 64 上限 —— 和吸顶栏共用一份配方。
  const stripRule = /\[data-dockkit-strip\]::before \{[^}]*\}/.exec(base.css)?.[0] ?? '';
  check(
    'the tab strip frosts what is behind it',
    stripRule.includes('backdrop-filter: blur(') && stripRule.includes('color-mix'),
  );
  check(
    'and the fill stays translucent - a solid band would read as a seam',
    /background: color-mix\(in srgb, var\(--dshbg-raw-base\) \d+%, transparent\)/.test(stripRule),
  );
  check('the frost is the sticky-head recipe (floor 32)', stripRule.includes('blur(32px)'));
  // 1.3.25：模糊**必须**在 `::before` 上，不能在 strip 自己身上。
  //
  // `backdrop-filter` 会让元素成为**固定定位后代的包含块**，而宿主的 Tooltip 是
  // `position: fixed` + 视口坐标，`portal` 又默认 false（`Tooltip({...portal: f=!1})`），
  // 所以「新建标签」「分屏」这些提示就躺在这条 strip 里。实测：直接糊在 strip 上，
  // tooltip 从 (420,200) 跑到 (500,320)，正好整平移了 strip 自己的偏移。
  check(
    'the strip itself is never a backdrop root - its inline tooltips are position:fixed',
    !/\[data-dockkit-strip\] \{[^}]*backdrop-filter/.test(base.css),
  );
  check(
    'the frost layer sits under the content instead of over it',
    /\[data-dockkit-strip\]::before \{[^}]*z-index: -1/.test(base.css) &&
      /\[data-dockkit-strip\] \{[^}]*isolation: isolate/.test(base.css),
  );
  const stripWide = (await emit({ menuBlur: 40 })).css;
  check(
    'and it follows the menu blur up to the 64 cap',
    /\[data-dockkit-strip\]::before \{[^}]*blur\(64px\)/.test(stripWide),
  );

  // 1.3.23 起：**提问中、还没答**的那张卡自己接管表面。
  //
  // ⚠️ 1.3.24 纠正：它不是用户截图里那张。截图那张是**已答回执**
  // （`[data-question-reply]` → `QuestionReplyView`），出在消息流里；这张出在输入区
  // （`.wnLwla_frame` 带 composer clearance）。1.3.23 曾把「圆角外套直角」判给它，
  // 因此还写了「摘掉输入框两层壳」的规则 —— 那两张壳根本不是它的祖先，规则一次都没
  // 匹配过。真凶在 `question card + dock strip` 那一段：`[class*="_bubble"]` 子串命中
  // 限宽壳 `_bubbleWidth`。假的修法已经删掉，别再加回来。
  // 两条选择器现在写在同一个规则里（`QUESTION_CARDS`），中间隔着逗号和第二个前缀，
  // 所以用 `[^{]*` 把那段一并吃进来。
  const qCard = /\[data-question-key\] > section[^{]*\{([^}]*)\}/.exec(base.css)?.[1] ?? '';
  check('the question card owns its own surface', qCard.includes('background-color'));
  check(
    'and it frosts the wallpaper instead of inheriting the input token',
    qCard.includes('backdrop-filter: blur(') && qCard.includes('22%'),
  );
  check(
    'its ring is an inset shadow - an outer one is the thing that went square',
    qCard.includes('inset 0 0 0 1px') && !qCard.includes('--dsw-elevation-panel'),
  );
  check(
    'and nothing is stood down behind it - the composer-shell theory was wrong',
    !base.css.includes(':has([data-question-key])'),
  );
  // 1.4.4：同一张卡的孪生兄弟 —— 宿主的「计划待审」面板（`PlanReviewPanel`）形状完全一样
  // （`frame > section`），底色也取自 `--dsw-specific-input-major`。它以前不在这条规则里，
  // 于是卡自己没背景、正文从底下透出来。
  const reviewCard = /\[data-plan-review-key\] > section[^{]*\{([^}]*)\}/.exec(base.css)?.[1] ?? '';
  check('the plan review card is covered at all', reviewCard.length > 0);
  check(
    'and it gets the same wallpaper frost, not the input token',
    reviewCard.includes('backdrop-filter: blur(') && reviewCard.includes('22%'),
  );
  check(
    'the two cards share one rule instead of two drifting copies',
    /\[data-question-key\] > section,[\s\S]{0,160}?\[data-plan-review-key\] > section \{/.test(base.css),
  );
  // 1.4.4 的诊断入口。宿主换节点时，「这三块到底吃到了什么样式」不能再靠读 TSX 猜 ——
  // 类名是哈希的，算出来的背景也可能被任何一条后来者盖掉。
  check('the probe is installed', typeof base.window.__dshbgProbe === 'function');
  if (typeof base.window.__dshbgProbe === 'function') {
    let probed = null;
    let threw = null;
    try {
      probed = base.window.__dshbgProbe();
    } catch (failure) {
      threw = failure;
    }
    check('and it never throws just because a surface is not on screen', threw === null, String(threw));
    check(
      'it answers for all three surfaces in one call',
      probed !== null && probed.composer !== undefined && probed.planReview !== undefined
        && probed.presentedFile !== undefined,
    );
    check(
      'it reports absence instead of inventing a reading',
      probed !== null && probed.planReview.found === false
        && probed.planReview.insideComposer === false,
      JSON.stringify(probed === null ? null : probed.planReview),
    );
    // 1.4.5：截图能看出「输入框停在半空」，但看不出高度去了哪儿 —— 只有祖先链上的
    // position/flex/height/overflow/scrollHeight 能回答，所以探针必须把它一起带出来。
    check(
      'and it carries the layout chain, so "where did the height go" is answerable',
      probed !== null && probed.layout !== undefined && Array.isArray(probed.layout.chain),
    );
    check(
      'the layout report leads with the viewport, so page zoom cannot hide',
      probed !== null && probed.layout.viewport !== undefined
        && 'zoom' in probed.layout.viewport && 'h' in probed.layout.viewport,
    );
  }
  // 诊断的最后一公里：要用户「开 DevTools、敲一行、复制」就等于没做。快捷键必须存在，
  // 而且要在 dispose 里摘掉 —— 插件关掉之后还抢键就是另一个 bug。
  check('one shortcut copies the report, instead of asking for DevTools', CODE.includes("'KeyD'"));
  check(
    'and that shortcut is released on dispose',
    CODE.includes("removeEventListener('keydown', onProbeKey"),
  );

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
  // 弹窗玻璃**不再由本插件负责**：费用明细自己的样式表里有一份补丁，由宿主半边在每次装配时
  // 查一遍签名、被升级冲掉就补回去（ENGINEERING.md 里有完整记录）。两边同时上色只会互相盖，
  // 而且它的规则永远更靠近宿主，所以这里断言本插件的样式表**不再提** `.cm-stat-dialog` ——
  // 谁改了这条，都会把弹窗重新推回互相覆盖。
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

  // 补丁会被 cost-meter 的每一次升级冲掉，所以它现在由宿主半边在装配时自己补回去。
  // 下面测的是**行为**：拿一个假包在临时目录里跑，逐个状态验，而不是断言源码里有某句话。
  console.log('\ncost-meter self-repair');
  const heal = await import(pathToFileURL(path.join(ROOT, 'cost-meter-patch.js')).href);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dshbg-heal-'));
  const fake = path.join(scratch, 'client.js');
  // 形状照抄真包（压缩过的 `Ɓ` 前缀、`/ 1` 结尾都保留）：锚点是在这段文本里找的。
  const ORIGINAL =
    'const css="Ɓsection,Ɓstat-dialog{Ƃƹ;Ƃrgb(from ƀbg-layer-2,ƀbg-base,#fff)) r g b / 1)}Ɓtoday-values{Ɠinline-flex}";';

  // ⚠️ 补丁是插在一个字符串字面量中间的。多一个引号 = 整个 cost-meter 从界面上消失，
  // 不只是弹窗。这条比任何样式断言都重要，所以放第一条。
  check(
    'the patch text cannot terminate the string literal it is spliced into',
    !/["'`\\]/.test(heal.PATCH),
  );

  fs.writeFileSync(fake, ORIGINAL, 'utf8');
  const first = heal.apply({ target: fake });
  const patched = fs.readFileSync(fake, 'utf8');
  check('a wiped patch is re-applied', first.status === 'patched');
  // ⚠️ 位置是这条补丁的全部内容。同一段 CSS 追加到文件结尾（CSS 字符串外面）在语法上
  // 完全合法、`replace` 也照样能反推回原文，所以「可逆」这条抓不住它 —— 必须单独钉住
  // 「紧跟在强制 alpha 的那条规则后面」。
  const cut = ORIGINAL.indexOf(heal.MARKER) + heal.MARKER.length;
  check(
    'and it lands inside the stylesheet, right after the rule that forces the alpha back to 1',
    patched.slice(0, cut) === ORIGINAL.slice(0, cut) && patched.slice(cut, cut + heal.PATCH.length) === heal.PATCH,
  );
  check(
    'and the splice is exactly reversible, so nothing else in the bundle moved',
    patched.replace(heal.PATCH, '') === ORIGINAL,
  );
  check('one copy only, never two', patched.split(heal.SIGNATURE).length === 2);
  check(
    'the pristine copy is kept next to it',
    fs.readFileSync(fake + heal.BACKUP_SUFFIX, 'utf8') === ORIGINAL,
  );

  const second = heal.apply({ target: fake });
  check('running it again is a no-op, not a second coat', second.status === 'already' && fs.readFileSync(fake, 'utf8') === patched);

  const untouched = path.join(scratch, 'no-anchor.js');
  fs.writeFileSync(untouched, 'const css=".cm-stat-dialog{background:#2c2c2e}";', 'utf8');
  const blind = heal.apply({ target: untouched });
  check(
    'a bundle that changed shape is reported, not blind-spliced',
    blind.status === 'anchor-missing' && fs.readFileSync(untouched, 'utf8') === 'const css=".cm-stat-dialog{background:#2c2c2e}";',
  );
  check('no backup is left behind when nothing was written', !fs.existsSync(untouched + heal.BACKUP_SUFFIX));

  check('an uninstalled cost meter is silent', heal.apply({ target: path.join(scratch, 'nope.js') }).status === 'missing');

  const undone = heal.revert({ target: fake });
  check('revert restores the original bytes', undone.status === 'restored' && fs.readFileSync(fake, 'utf8') === ORIGINAL);
  check('and stops the next boot from undoing the undo', heal.apply({ target: fake }).status === 'off');
  check(
    'the manual door still opens past that marker',
    heal.apply({ target: fake, force: true }).status === 'patched',
  );

  // 运行期间被升级也要补回来。01:46 那次 1.9.58 → 1.9.64 就是整包重写，而自愈只在启动时跑过
  // 一次，所以用户看到的是「这个更新了，又没了」。这里真的写一遍文件，等监听回调自己动手。
  fs.writeFileSync(fake, ORIGINAL, 'utf8');
  const seen = [];
  const watcher = heal.watchForWipe({ target: fake }, (r) => seen.push(r.status));
  check('a watcher is installed next to the bundle', watcher !== null && typeof watcher.close === 'function');
  await new Promise((r) => setTimeout(r, 120));
  fs.writeFileSync(fake, ORIGINAL, 'utf8'); // 模拟升级：整包重写，补丁没了
  await new Promise((r) => setTimeout(r, 900));
  check(
    'an upgrade installed while the app is running is repaired without a restart',
    fs.readFileSync(fake, 'utf8').includes(heal.SIGNATURE) && seen.includes('patched'),
  );
  // 兄弟文件的写入不许被当成升级：补丁自己就会写 `.dshbg-orig`，认错了就会自己叫自己。
  const settled = seen.length;
  fs.writeFileSync(fake + heal.BACKUP_SUFFIX, fs.readFileSync(fake, 'utf8'), 'utf8');
  await new Promise((r) => setTimeout(r, 700));
  check('writing a sibling file is not mistaken for an upgrade', seen.length === settled);

  // 复现 2026-11-14 23:26 的现场：1.9.64 → 1.9.65 更新时整个包目录被替换，change 事件正好
  // 落在 `client.js` 还不存在的空窗里。旧实现读到 `missing` 就永久放手，日志里只剩一行
  // `watcher missing`，补丁再也没回来 —— 也就是用户说的「每次更新都会失去玻璃」。
  // 现在必须在退避重试里自己回来，而不是等人来跑脚本。
  fs.writeFileSync(fake, ORIGINAL, 'utf8');
  await new Promise((r) => setTimeout(r, 500));
  const beforeMiss = seen.length;
  fs.rmSync(fake, { force: true }); // 替换开始：文件消失
  await new Promise((r) => setTimeout(r, 620)); // 越过第一次 400ms 的尝试，此时 apply 必读 missing
  fs.writeFileSync(fake, ORIGINAL, 'utf8'); // 替换完成：文件回来，但补丁没了
  await new Promise((r) => setTimeout(r, 1400));
  check(
    'a change that lands while the package is being replaced is still repaired',
    fs.readFileSync(fake, 'utf8').includes(heal.SIGNATURE) && seen.length > beforeMiss,
  );
  // 事件本身不可靠（Windows 在扫描新装的包时会合并事件），所以还有一个指纹轮询兜底。
  check(
    'and a slow fingerprint poll backs the watcher up',
    typeof heal.DEFAULT_POLL_MS === 'number' && heal.DEFAULT_POLL_MS > 0 && heal.DEFAULT_POLL_MS <= 60_000,
  );
  watcher?.close();

  // pnpm 升级不是「改这个文件」，是「把整个包目录 rename 换掉」。被 watch 的 inode 随旧目录
  // 一起删除，libuv 于是对 FSWatcher emit `EPERM` —— 没有 error 监听就是个 unhandled error，
  // 直接冒到宿主主进程。2026-11-14 用 probe-dirswap.mjs 复现过：
  //   Error: EPERM: operation not permitted, watch -> Unhandled 'error' event -> 进程退出
  // 一个化妆品补丁不该有这个能力。这条断言两件事：不崩，而且能自己回来。
  // ⚠️ 如果哪天这条回归了，失败形式是整个测试进程崩掉，而不是一行 FAIL —— 那正是信号。
  const swapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshbg-swap-'));
  const swapPkg = path.join(swapRoot, 'dsh-cost-meter');
  fs.mkdirSync(path.join(swapPkg, 'lib'), { recursive: true });
  const swapTarget = path.join(swapPkg, 'lib', 'client.js');
  fs.writeFileSync(swapTarget, ORIGINAL, 'utf8');
  const swapWatcher = heal.watchForWipe({ target: swapTarget, pollMs: 200 }, () => {});
  heal.apply({ target: swapTarget });
  const staged = path.join(swapRoot, 'staged');
  fs.mkdirSync(path.join(staged, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(staged, 'lib', 'client.js'), ORIGINAL, 'utf8');
  fs.rmSync(swapPkg, { recursive: true, force: true }); // 旧包目录整个消失
  fs.renameSync(staged, swapPkg); // 原子换入新包
  await new Promise((r) => setTimeout(r, 1800));
  check(
    'a package replaced wholesale does not crash the host, and the patch comes back',
    fs.readFileSync(swapTarget, 'utf8').includes(heal.SIGNATURE),
  );
  swapWatcher?.close();
  fs.rmSync(swapRoot, { recursive: true, force: true });

  const INDEX = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  check(
    'the host half repairs it while assembling, not when the user opens the dialog',
    /from '\.\/cost-meter-patch\.js'/.test(INDEX) && /try \{[\s\S]{0,240}healCostMeter\(\)/.test(INDEX),
  );
  check(
    'and keeps a watcher for upgrades that land while the app is running',
    /watchForWipe/.test(INDEX) && /watcher = watchForWipe\(/.test(INDEX),
  );
  check('the repair module ships with the plugin', MANIFEST.files.includes('cost-meter-patch.js'));

  // 装配这条路依赖宿主真的把 host 半边装起来，而这件事从插件内部看不出来。2026-11-14 实测：
  // 同一个函数离线调用 400ms 就修好了，真实运行中的 DSH 里却一直没修 —— 所以加了一条不欠
  // DSH 任何东西的入口：登录时跑一次的独立脚本。
  check(
    'the host half is registered under the package name, not anonymously',
    /export const name = 'dsh-private-background'/.test(INDEX),
  );
  const HEAL = path.join(ROOT, 'tools', 'cost-meter-heal.mjs');
  check('a login hook exists that needs nothing from the host', fs.existsSync(HEAL));
  const HEAL_SRC = fs.readFileSync(HEAL, 'utf8');
  check(
    'and it drives the same implementation rather than a second copy of the patch',
    /\.\.\/cost-meter-patch\.js/.test(HEAL_SRC) && !/backdrop-filter:blur\(46px\)/.test(HEAL_SRC),
  );
  check(
    'and it ignores the off-marker, or --revert would become permanent by accident',
    /apply\(\{ force: true \}\)/.test(HEAL_SRC),
  );

  // 真的用子进程跑一遍：ESM 后缀、参数解析、退出码、以及「改完之后文件确实是补丁版」。
  // 日志和 target 都指到临时目录，免得污染这台机器上真实的那份。
  //
  // ⚠️ 有些环境（沙箱、杀软、node.exe 正被占用）不允许再 spawn 一个 node，返回 EBUSY。
  // 那不是代码的问题，所以降级成 4 条 skip 而不是 FAIL —— 但它们必须仍然计数，否则项数会
  // 随机器浮动，读起来像是少测了东西。
  const runHeal = (args) =>
    require('node:child_process').spawnSync(process.execPath, [HEAL, ...args], {
      env: { ...process.env, DSHBG_COST_METER: fake, DSHBG_LOG_FILE: path.join(scratch, 'heal.log') },
      encoding: 'utf8',
    });
  fs.writeFileSync(fake, ORIGINAL, 'utf8');
  const hookRun = runHeal(['--quiet']);
  const spawnable = !hookRun.error;
  const skipReason = spawnable ? '' : `cannot spawn here (${hookRun.error.code})`;
  const spawnCheck = (name, condition) =>
    spawnable ? check(name, condition) : skip(name, skipReason);
  spawnCheck(
    'the login hook repairs a wiped file and exits 0',
    spawnable && hookRun.status === 0 && fs.readFileSync(fake, 'utf8').includes(heal.SIGNATURE),
  );
  spawnCheck(
    'and stays silent when there is nothing to do',
    spawnable && hookRun.stdout.trim() === '' && hookRun.stderr.trim() === '',
  );
  fs.writeFileSync(fake, ORIGINAL, 'utf8');
  spawnCheck('while saying so on stdout when run by hand', spawnable && runHeal([]).stdout.includes('re-applied'));
  const logLines = fs.existsSync(path.join(scratch, 'heal.log'))
    ? fs.readFileSync(path.join(scratch, 'heal.log'), 'utf8')
    : '';
  spawnCheck('the quiet run still leaves a trail of what it changed', spawnable && logLines.includes('login hook re-applied'));
  fs.rmSync(scratch, { recursive: true, force: true });

  // 双击就能救命的那一个。它是给人用的，不是给调度器用的 —— 所以三件事：调同一个入口
  // （不许出现第二份补丁文本）、跑完别闪退（没有 pause 的 cmd 双击等于什么都没发生）、
  // 并且必须能在中文 Windows 的默认代码页里正常显示（GBK 存盘）。
  const CMD = path.join(ROOT, '修复费用弹窗玻璃.cmd');
  check('a double-clickable repair script ships with the plugin', fs.existsSync(CMD));
  if (fs.existsSync(CMD)) {
    const raw = fs.readFileSync(CMD);
    // Node 的 Buffer.toString 不认 gbk，得走 TextDecoder（需要 full-icu，本机有）。
    const text = new TextDecoder('gbk').decode(raw);
    check('and it calls the same heal entry point, not a second copy of the patch',
      text.includes('cost-meter-heal.mjs') && !text.includes('backdrop-filter'));
    check('and it waits for a keypress instead of closing on the user', /^\s*pause\s*$/m.test(text));
    check('and the bytes are GBK, which is what a Chinese Windows console decodes by default',
      !raw.toString('utf8').includes('修复费用') && text.includes('修复费用'));
  }

  // 插件市场的全屏页：它自己用 layer-1 画底，而 layer-1 的语义是「比 pane 高一层」，
  // 带着 +8 的 lift。它不是 pane 之上的面板，它**就是**页面本身 —— 打开市场整窗比刚才的
  // 对话暗八个百分点，看起来就像另开了一层板。
  //
  // 但它也**不该**照抄对话区的 22%：整页都是 12px 小字直接坐在页面上，底下一亮字就发飘。
  // 45% 是「字站得住、壁纸还是张照片」的位置。所以断言的是「它自己画底、不是 layer-1 的
  // lift」，以及「浓度明显高于对话区」—— 不是钉死某个数字。
  console.log('\nplugin market');
  // ⚠️ 这条断言的前一版钉在 `[data-dsh-market-plugins-tab][data-dsh-market-fullscreen]` 上，
  // 而市场自己的渲染里 `fullscreen` 只在 `tab === "themes"` 时才写 —— 插件页上那个选择器
  // **一个元素都不匹配**。规则在样式表里、断言全绿、屏幕上一像素都没变，这正是「绿灯可能
  // 在保护 bug」。所以现在断言的是「填充落在根元素上」，也就是**那个确实存在的元素**。
  const marketRule = new RegExp(
    `html\\[data-dshbg-on\\] \\[data-dsh-market-root\\] \\{[^}]*?background: color-mix\\(in srgb, var\\(--dshbg-raw-base\\) (\\d+)%, transparent\\)`,
  );
  const marketFill = marketRule.exec(base.css);
  check('the market page paints its own base, on the root that every surface actually has', marketFill !== null);
  check(
    'and it is heavier than a chat pane, because its body text sits straight on the page',
    marketFill !== null && Number(marketFill[1]) >= 40,
    marketFill === null ? '' : `fill ${marketFill[1]}%`,
  );
  // 反过来钉住那个已经死掉的选择器：填充一旦回到它身上，插件页又会变回「什么都不画」。
  check(
    'and it is not gated on the attribute that only the themes tab sets',
    !/data-dsh-market-fullscreen[^{]*\{[^}]*?background: color-mix/.test(base.css),
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
  // 滚动容器自己的 8px 顶部内边距要摘掉：那块区域在吸顶栏盒子之外，只吃到根元素的填充，
  // 密度比吸顶栏低一截 —— 屏幕上就是搜索框上面那条浅色带子。摘掉之后没有「栏外」了。
  check(
    "the scroller's own top padding is removed, so nothing is left above the header at a different density",
    /\[data-dsh-market-root\] \[class\$="_body"\] \{\s*padding-top: 0 !important/.test(base.css),
  );
  // ⚠️ 吸顶栏**不能**靠重填充去盖内容：它上面是页面（更浅），填充一重就变成一条带硬边的
  // 深色横条 —— 缝只是往下挪了一行。真正抹掉卡片的是模糊，而且要比菜单的强得多：
  // 一条 1px 的 16% 白描边在 `menuBlur` 下会活成一道软弧。所以测的是「填充是耳语、模糊够大」。
  const headRule = /\[data-dsh-market-root\] \[class\$="_stickyHead"\] \{([^}]*)\}/.exec(base.css);
  const headBody = headRule === null ? '' : headRule[1];
  const headFill = /background: color-mix\(in srgb, var\(--dshbg-raw-base\) (\d+)%/.exec(headBody);
  const headBlur = /backdrop-filter: blur\((\d+)px\)/.exec(headBody);
  check(
    'the sticky header hides the cards behind it with blur, not with a heavy fill',
    headFill !== null && Number(headFill[1]) <= 20,
    headFill === null ? 'no fill' : `fill ${headFill[1]}%`,
  );
  check(
    'and that blur is well past the menu value, because it has to erase 12px card titles',
    headBlur !== null && Number(headBlur[1]) >= 32,
    headBlur === null ? 'no blur' : `blur ${headBlur[1]}px`,
  );
  // 插件页表头改跟壁纸滑杆之后，市场页的上限必须在这里自己接受检验，不能再借另一条
  // 规则的断言「顺便」覆盖；那条路一断，删掉 `Math.min(64, …)` 就会静默全绿。
  const marketHeadAt = async (menuBlur) => {
    const css = (await emit({ menuBlur })).css;
    const rule = /\[data-dsh-market-root\] \[class\$="_stickyHead"\] \{([^}]*)\}/.exec(css);
    return rule === null ? '' : rule[1];
  };
  check(
    'the market header keeps its own 64px ceiling',
    (await marketHeadAt(77)).includes('blur(64px) saturate(150%)'),
  );
  check(
    "and the header's own box starts at the scroller's top edge, flush",
    /top: 0 !important[^}]*?margin-top: 0 !important/.test(headBody),
  );
  // 宿主那条 14px 带子只写了 `background: inherit` —— 只继承颜色、不继承 `backdrop-filter`。
  // 再给它补一条模糊也不对：那会变成两个各自模糊、各自加填充的层，交界处照样是硬台阶。
  check(
    "the host's 14px strip is removed rather than re-blurred",
    /\[class\$="_stickyHead"\]::before \{\s*display: none !important/.test(base.css),
  );
  // 只圆下面两个角：上面两个角紧贴着页面（同一密度），圆了就是在顶上挖两个浅色缺口 ——
  // 又一个「缝」。下面圆角配上下面的空隙，才是「浮起来的一条」。
  check(
    'the header is rounded on the bottom only, because its top edge is flush with the page',
    /border-radius: 0 0 16px 16px !important/.test(headBody),
  );
  // 最后一行是「已隐藏 N 个…」，第一排卡片以前直接顶上来。要用 padding 不能用 margin ——
  // margin 留的是**能看见卡片滚过去**的空隙。
  check(
    'and there is a filled gap below it instead of butting into the first row of cards',
    /padding-bottom: 10px !important/.test(headBody),
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
  // 现在是三处：插件详情页的配置、主区域里的同一个配置页、左栏图标。
  check(
    'mode none still registers the config page and the sidebar entry',
    off.registered.length === 3,
    `got ${off.registered.length}`,
  );

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
  // 三个座位。插件详情页那份给「设置 → 插件」用；`main` + `sidebar.panellist` 是左栏
  // 入口，**两者必须成对** —— 只有图标没有 main 时，宿主 selectPanel 会抛错并保留当前
  // 选中态，屏幕上就是「图标点不动」，没有任何提示。所以这里测的是「成对」，不是
  // 「有没有图标」。
  const slotByName = new Map(base.registered.map((entry) => [entry.options.name, entry]));
  check('three slot registrations', base.registered.length === 3, `got ${base.registered.length}`);
  const bundleConfig = slotByName.get('plugins.bundle.config');
  check('registers into plugins.bundle.config', bundleConfig !== undefined);
  check(
    'keyed by the package name',
    bundleConfig !== undefined && bundleConfig.options.key === MANIFEST.name,
    bundleConfig === undefined ? '' : `${String(bundleConfig.options.key)} vs ${MANIFEST.name}`,
  );
  // 左栏那一条：id 与 `main` 的 key 必须是同一个字符串，否则点击时找不到面板。
  const sidebarEntry = slotByName.get('sidebar.panellist');
  const mainEntry = slotByName.get('main');
  check('the sidebar icon is registered', sidebarEntry !== undefined);
  check('and the panel it selects is registered too', mainEntry !== undefined);
  check(
    'the two are addressed by the same id, which is what makes the click resolve',
    sidebarEntry !== undefined &&
      mainEntry !== undefined &&
      sidebarEntry.options.id === mainEntry.options.key &&
      sidebarEntry.options.id === 'custom-background',
    sidebarEntry === undefined || mainEntry === undefined
      ? ''
      : `${String(sidebarEntry.options.id)} vs ${String(mainEntry.options.key)}`,
  );
  // 面板拿到的 `view` 必须是 `page`：只有它会让配置页挂上 `data-dshbg-config`，而那个属性
  // 是页面透明的开关 —— 调壁纸时得能看见壁纸。
  check(
    'the panel is handed view=page so the page stays transparent behind the sliders',
    mainEntry !== undefined && mainEntry.options.inject().view === 'page',
  );
  // 图标排在宿主自己的条目（plugins 是 0）后面，不去挤内置面板。
  check(
    'the sidebar icon sorts after the host entries',
    sidebarEntry !== undefined && Number(sidebarEntry.options.order) > 0,
  );
  // 面板必须自带框：配置页自己没有内边距，插件详情页那边是宿主给的，main 没有。少了
  // 这一层，表单会直接贴在窗口边上，而且滚不动。
  let panelFrame = null;
  try {
    panelFrame = mainEntry === undefined ? null : mainEntry.component({ view: 'page' });
  } catch (failure) {
    panelFrame = null;
  }
  check(
    'the panel supplies the padding the plugin page used to give',
    panelFrame !== null &&
      panelFrame.props !== null &&
      typeof panelFrame.props === 'object' &&
      panelFrame.props.className === 'dshbg-panel',
  );
  check('and that frame is styled', CODE.includes('.dshbg-panel {') && CODE.includes('.dshbg-panel > .dshbg'));
  // 图标是内联 SVG，不额外 inject 一个图标库 —— 侧栏只给 `size`，一个 16px 的形状不值得
  // 为它多挂一个宿主模块（那条 inject 写错会让整个插件启动失败）。
  check(
    'the glyph is drawn inline rather than imported',
    CODE.includes('function WallpaperIcon({ size })') && !/inject: \[[^\]]*ui-primitives/.test(CODE),
  );

  console.log('\nsidebar entry switch');
  // 关掉的是**图标**，不是左栏。而且页面必须留着：宿主 `retainMainPanels` 在 `main` 注册
  // 消失时会把选中项弹回对话，那样这个开关就会在按下的瞬间毁掉自己所在的页面。
  const hidden = await emit({ mode: 'none', sidebarEntry: false });
  const hiddenNames = hidden.registered.map((entry) => entry.options.name);
  check(
    'the icon is simply not registered when the switch is off',
    !hiddenNames.includes('sidebar.panellist'),
    hiddenNames.join(','),
  );
  check(
    'but the page it opens stays registered, so the host keeps its selection',
    hiddenNames.includes('main'),
    hiddenNames.join(','),
  );
  check('and nothing else is dropped', hidden.registered.length === 2, `got ${hidden.registered.length}`);
  // 老配置里没有这个键，用户不该一升级就发现图标自己没了。
  check(
    'a settings file without the key keeps the icon',
    base.registered.some((entry) => entry.options.name === 'sidebar.panellist'),
  );

  /** 在渲染出来的元素树里按 props.label 找那个开关。 */
  const findSwitch = (node, needle) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findSwitch(child, needle);
        if (found !== null) return found;
      }
      return null;
    }
    if (node.props !== null && typeof node.props === 'object' && String(node.props.label || '').includes(needle)) {
      return node;
    }
    const nested = [node.children, node.props === null ? null : Object.values(node.props || {})];
    for (const group of nested) {
      if (!Array.isArray(group)) continue;
      for (const child of group) {
        const found = findSwitch(child, needle);
        if (found !== null) return found;
      }
    }
    return null;
  };

  const switchNode = findSwitch(page, '在左侧栏显示');
  check('the switch is on the settings page', switchNode !== null);
  check('and it starts on', switchNode !== null && switchNode.props.checked === true);

  // 真正要证明的是「不重载也立刻生效」：宿主订阅了 `sidebar.panellist`，注册被撤掉的
  // 那一刻图标就没了。所以这里不是重新起实例，而是直接按设置页上那个开关。
  let flipError = null;
  try {
    if (switchNode !== null) switchNode.props.onChange(false);
  } catch (failure) {
    flipError = failure;
  }
  check('flipping it off does not throw', flipError === null, flipError === null ? '' : String(flipError));
  check(
    'and the icon goes away without a reload',
    !base.registered.some((entry) => entry.options.name === 'sidebar.panellist'),
  );
  check(
    'while the page it opens is still there',
    base.registered.some((entry) => entry.options.name === 'main'),
  );
  check(
    'the answer is written down rather than inferred',
    String(base.store.get('dsh.custom-background.settings.v4') || '').includes('"sidebarEntry":false'),
    String(base.store.get('dsh.custom-background.settings.v4')),
  );

  // 翻回去必须回到同一个 id，否则点图标时宿主找不到面板（选择器是 id 对 id）。
  const again = base.registered[0].component({ view: 'page' });
  const againSwitch = findSwitch(again, '在左侧栏显示');
  check('the page still renders the switch after the flip', againSwitch !== null);
  check('and it now reads off', againSwitch !== null && againSwitch.props.checked === false);
  if (againSwitch !== null) againSwitch.props.onChange(true);
  check(
    'flipping it back puts the same entry back',
    base.registered.some(
      (entry) => entry.options.name === 'sidebar.panellist' && entry.options.id === 'custom-background',
    ),
    base.registered.map((entry) => entry.options.name).join(','),
  );
  check('and the count returns to three', base.registered.length === 3, `got ${base.registered.length}`);

  // 关着启动的实例，页面上那个开关也得读回「关」，而不是默认值。
  const hiddenPage = hidden.registered[0].component({ view: 'page' });
  const hiddenSwitch = findSwitch(hiddenPage, '在左侧栏显示');
  check('a stored off reads back off', hiddenSwitch !== null && hiddenSwitch.props.checked === false);
  if (hiddenSwitch !== null) hiddenSwitch.props.onChange(true);
  check(
    'and turning it on in that instance registers the icon too',
    hidden.registered.some((entry) => entry.options.name === 'sidebar.panellist'),
  );

  // 宿主那边还有第二道闸：行被「取消固定」之后只进「更多」，重新注册也不会回到列表里。
  // 这两扇门其实是同一个决定 —— 在左栏点「取消固定」就等于关掉这个开关。
  // 不承认这一点，设置页就会一直说「开着」，而界面上什么都没有（用户报的就是这个）。
  const subscribesBefore = base.pins.subscribes;
  base.pins.unpin('custom-background');
  await new Promise((resolve) => setTimeout(resolve, 12));
  const foldedPage = base.registered[0].component({ view: 'page' });
  const foldedSwitch = findSwitch(foldedPage, '在左侧栏显示');
  check(
    'closing the row from the sidebar turns the switch off',
    foldedSwitch !== null && foldedSwitch.props.checked === false,
  );
  check(
    'and the icon leaves with the fold',
    !base.registered.some((entry) => entry.options.name === 'sidebar.panellist'),
    base.registered.map((entry) => entry.options.name).join(','),
  );
  check(
    'the fold is written down, not just painted',
    String(base.store.get('dsh.custom-background.settings.v4') || '').includes('"sidebarEntry":false'),
    String(base.store.get('dsh.custom-background.settings.v4')),
  );
  check(
    'one listener, however many commits it lives through',
    base.pins.subscribes === subscribesBefore,
    `${subscribesBefore} -> ${base.pins.subscribes}`,
  );

  // 翻回去仍然是「注册 + 固定」两件事一起做，否则会回到「开关开着、按钮看不见」。
  if (foldedSwitch !== null) foldedSwitch.props.onChange(true);
  check(
    'flipping it back on registers the icon again',
    base.registered.some((entry) => entry.options.name === 'sidebar.panellist'),
  );
  check('and pins the row it just registered', base.pins.unpinned.length === 0, base.pins.unpinned.join(','));
  check(
    'and it asks for the right id',
    base.pins.calls.some(([id, pinned]) => id === 'custom-background' && pinned === true),
    JSON.stringify(base.pins.calls.slice(-3)),
  );
  const report = typeof base.window.__dshbgEntry === 'function' ? base.window.__dshbgEntry() : null;
  check(
    'the probe reports registered, pin-control available, and not folded',
    report !== null && report.enabled === true && report.pinControl === true && report.folded === false,
    JSON.stringify(report),
  );
  check(
    'and it says whether the plugin is listening to the host',
    report !== null && report.watching === true,
    JSON.stringify(report),
  );

  // 「开关开着、行却在更多里」这种半截状态不用等用户去拨开关：打开设置页就该被纠正 ——
  // 那正是他要看这个开关的时刻。
  const half = await emit({ mode: 'none' });
  half.pins.unpinned = ['custom-background'];
  const halfPage = half.registered[0].component({ view: 'page' });
  check('opening the page puts a folded row back on its own', half.pins.unpinned.length === 0, half.pins.unpinned.join(','));
  check('and the page still renders', halfPage !== null);

  // 宿主把注入面换掉时（`setPinned` 不见了），开关必须照旧注册，只是不再声称自己固定住了。
  const noPin = await emit({ mode: 'none' }, { noPinControl: true });
  check(
    'a host without a pin control still gets the icon',
    noPin.registered.some((entry) => entry.options.name === 'sidebar.panellist'),
  );
  const noPinReport = typeof noPin.window.__dshbgEntry === 'function' ? noPin.window.__dshbgEntry() : null;
  check(
    'and the probe admits there is no pin control rather than pretending',
    noPinReport !== null && noPinReport.pinControl === false && noPinReport.folded === null,
    JSON.stringify(noPinReport),
  );
  check('nothing was pinned on that host', noPin.pins.calls.length === 0, String(noPin.pins.calls.length));

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
