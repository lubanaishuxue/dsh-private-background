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

function flag(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

const CSS_OUT = flag('css-out');
const OVERRIDES = (() => {
  const raw = flag('settings');
  if (raw === null) return {};
  try {
    return JSON.parse(raw);
  } catch (failure) {
    console.error(`--settings is not valid JSON: ${failure.message}`);
    process.exit(1);
  }
})();
const CODE = fs.readFileSync(CLIENT, 'utf8');

const BASE_SETTINGS = {
  mode: 'gradient',
  gradient: 2,
  color: '#12324a',
  blur: 16,
  dim: 0,
  surface: 20,
  chatSurface: 78,
  composerSurface: 85,
  fullWindow: false,
  font: 'theme',
  fontColor: '#f7f8fa',
};

function makeElement(tag, computed) {
  const vars = {};
  const el = {
    tagName: tag,
    dataset: {},
    attributes: {},
    style: {
      setProperty(name, value) { vars[name] = String(value); },
      getPropertyValue(name) { return vars[name] === undefined ? '' : vars[name]; },
      removeProperty(name) { delete vars[name]; },
    },
    textContent: '',
    children: [],
    isConnected: true,
    // The detector reads computed styles off whatever it is handed, so a fake node has to
    // be able to answer. `_computed` is the per-node answer; the default is "invisible,
    // nothing painted", which is what keeps the detector out of every other scenario.
    _computed: computed || {
      display: 'block',
      visibility: 'visible',
      backgroundImage: 'none',
      backgroundColor: 'rgba(0, 0, 0, 0)',
    },
    _box: { width: 0, height: 0 },
    getBoundingClientRect() { return { ...el._box, x: 0, y: 0, top: 0, left: 0 }; },
    getElementsByTagName() { return []; },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
    hasAttribute(name) { return name in el.attributes; },
    removeAttribute(name) { delete el.attributes[name]; },
    appendChild(child) { el.children.push(child); return child; },
    remove() {
      const owner = el._parent;
      if (owner) {
        const index = owner.children.indexOf(el);
        if (index >= 0) owner.children.splice(index, 1);
      }
    },
    contains() { return false; },
    closest() { return null; },
  };
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

/** One isolated plugin instance. Returns the CSS it emitted plus the DOM it touched. */
function harness(settingsOverride, options) {
  const settings = { ...BASE_SETTINGS, ...settingsOverride };
  const head = makeElement('head');
  const documentElement = makeElement('html');
  const body = makeElement('body');
  body._parent = documentElement;
  // The detector walks `body.getElementsByTagName('*')`; a scenario that wants it to find
  // anything hands its fake panels in here.
  const nodes = options && options.nodes ? options.nodes : [];
  body.getElementsByTagName = () => nodes;

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
      // 探测器在 work-area 作用域下用它划界线：`#root` 里面是主题自己的地盘。
      if (selector === '#root') return (options && options.root) || null;
      return null;
    },
    querySelectorAll() { return []; },
  };

  const window = {
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); },
    },
    getComputedStyle(el) {
      if (el && el._computed) return el._computed;
      return { backgroundImage: 'none' };
    },
    // A never-resolving open() keeps boot() pending, which is what the host looks like
    // before the first image read lands.
    indexedDB: { open() { return {}; } },
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

  const observers = [];

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
    // 探测器靠 MutationObserver 驱动。桩把它记下来，测试才能主动触发一次扫描 ——
    // 「框架重渲染抹掉内联变量」这种场景没法靠等，只能自己拍一下。
    MutationObserver: class {
      constructor(callback) { this._callback = callback; observers.push(this); }
      observe() {}
      disconnect() {}
      fire() { if (this._callback) this._callback([]); }
    },
    // 跑马灯在 measure() 里读内边距，用的是裸 getComputedStyle（渲染进程里就是 window 上那个）。
    getComputedStyle: window.getComputedStyle,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'client.js' });

  return { definition, ctx, registered, documentElement, head, observers };
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
 * Pull one number out of a matched CSS block, defensively.
 *
 * Assertions should not be able to crash the suite: when the rule is missing entirely this
 * returns NaN, and `NaN < x` / `NaN === x` are both false, so the assertion reports FAIL the
 * normal way instead of throwing on a null match halfway through the run.
 */
function pick(block, pattern) {
  const found = block === null ? null : pattern.exec(block);
  return found === null ? Number.NaN : Number(found[1]);
}

/** Apply the plugin with the given settings and return the emitted stylesheet. */
async function emit(settingsOverride, options) {
  const run = harness(settingsOverride, options);
  const { definition, ctx, registered, documentElement, head } = run;

  const exported = definition.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  exported.apply(ctx);

  // The auto-contrast measurement lands on a microtask; let it commit before reading.
  await new Promise((resolve) => setTimeout(resolve, 12));

  const tags = head.children.filter((el) => el.attributes['data-dshbg-css']);
  return {
    definition,
    exported,
    registered,
    documentElement,
    tags,
    observers: run.observers,
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
  check('paints the wallpaper layer', base.css.includes('html[data-dshbg-on]::before'));
  check('adds the dimming layer', base.css.includes('html[data-dshbg-on]::after'));
  check('uses the gradient preset', base.css.includes('linear-gradient(135deg, #ff9a9e'));
  check('blur value present', base.css.includes('filter: blur(16px)'));
  check('clears html background', base.css.includes('html[data-dshbg-on] { background: transparent !important; }'));
  check('clears body background', base.css.includes('html[data-dshbg-on] body,'));

  console.log('\ntoken plumbing');
  check('captures the base surface', base.css.includes('--dshbg-raw-base: var(--dsw-alias-bg-base)'));
  check('captures the sidebar fill', base.css.includes('--dshbg-raw-sidebar: var(--dsw-specific-sidebar-fill)'));
  check('captures label tokens for the settings page', base.css.includes('--dshbg-raw-label-0: var(--dsw-alias-label-primary)'));
  check('re-mixes the base surface', base.css.includes('--dsw-alias-bg-base: color-mix'));
  check('keeps elevation order', /--dsw-alias-bg-layer-2: color-mix\(in srgb, var\(--dshbg-raw-l2\) 36%/.test(base.css));
  // **捕获在 <body>，重混在 `body > *`，两半都是承重的。**
  //
  // `--dshbg-raw-x: var(--dsw-alias-x)` 是「计算值时刻」的替换：它读的是**声明它的那个
  // 元素**上的 `--dsw-alias-x`。捕获和重混放在同一元素上，捕获就会读到已经被重混过的值，
  // 整条配方塌成透明。
  //
  // 而捕获必须在 `body` 上，因为**主题就是声明在 `body` 上的**：DSH 的调色板是
  // `body { --dsw-alias-* }`（浅色）和 `body[data-ds-dark-theme] { --dsw-alias-* }`（深色），
  // 不是 `:root`。自定义属性只向下继承，所以捕获挂在 `<html>` 上时每一个 token 读到的都是
  // guaranteed-invalid：`color-mix(in srgb, <空> 16%, transparent)` 在计算值时刻非法 →
  // 重混出来的属性也非法 → `background: var(--dsw-alias-bg-layer-2)` 退回 `transparent`。
  //
  // **这是一个真实的线上 bug**：所有「16% 不透明」的面板其实全透明，看起来像玻璃全靠
  // backdrop-filter。这三条断言钉住的就是这个结构。
  check(
    'capture sits on <body>, where the theme declares its tokens',
    /html\[data-dshbg-on\] body \{[^}]*--dshbg-raw-base: var\(--dsw-alias-bg-base\)/.test(base.css),
  );
  check(
    'the capture is not on <html>, where the tokens do not exist',
    !/html\[data-dshbg-on\] \{[^}]*--dshbg-raw-base:/.test(base.css),
  );
  check(
    're-mix sits one level below the capture, so it cannot read itself',
    /html\[data-dshbg-on\] body > \* \{[^}]*--dsw-alias-bg-base: color-mix/.test(base.css),
  );
  check(
    'the re-mix covers #root and every portal, but not body itself',
    !/html\[data-dshbg-on\] body \{[^}]*--dsw-alias-bg-base: color-mix/.test(base.css),
  );
  check(
    'the re-mix is NOT fenced into the app frame',
    !/html\[data-dshbg-on\] #root div:has\(> \[data-shell-overlay\]\) \{[^}]*--dsw-alias-bg-base: color-mix/.test(
      base.css,
    ),
  );

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

  // The sidebar has a floor. Without one, `surface: 0` - the setting that makes everything
  // else maximally glassy - leaves the column with no fill at all, and a sidebar with no
  // fill is not "more glassy", it is gone: nav items and the workspace group float on the
  // photograph with nothing to belong to. See `SIDEBAR_FLOOR`.
  //
  // 40 is the readability floor and it stays 40. 2.27.1 tried 28 in the same release that
  // fixed the double paint; the column got light enough to wash out the dark theme's
  // near-white icons ("侧边栏按钮没了"). The number never needed to move - only the
  // number of painters did.
  const sidebarAlpha = (css) =>
    pick(
      /--dsw-specific-sidebar-fill: color-mix\(in srgb, var\(--dshbg-raw-sidebar\) (\d{1,3})%, transparent\)/.exec(css),
      /(\d{1,3})%/,
    );
  check('the sidebar keeps a base at surface 0', sidebarAlpha((await emit({ fullWindow: true, surface: 0 })).css) === 40);
  check('the floor is a floor, not a lift', sidebarAlpha((await emit({ fullWindow: true, surface: 25 })).css) === 40);
  check('above the floor the slider still wins', sidebarAlpha((await emit({ fullWindow: true, surface: 70 })).css) === 70);
  check('the floor never makes the sidebar solid', sidebarAlpha((await emit({ fullWindow: true, surface: 100 })).css) === 100);

  // One surface, one painter. The sidebar column and the root inside it paint the same
  // token, which is invisible while both are opaque and doubles the veil once they are not:
  // a declared 40% arrives as `1 - 0.6²` = 64%. That was v2.27.0's live regression.
  console.log('\ncolumn paint');
  const frameSel = String.raw`#root div:has\(> \[data-shell-overlay\]\)`;
  check(
    'the sidebar column stops painting, so the fill lands once',
    new RegExp(
      String.raw`html\[data-dshbg-on\]\[data-windows-titlebar\] ${frameSel} > div:nth-of-type\(1\):has\(\[class\*="_root"\]\) \{\s*background: transparent !important;`,
    ).test(wide.css),
  );
  // The guard is the interlock: no root inside, no rule. A column with no painter at all
  // is an invisible sidebar with invisible buttons, which is worse than a dark one.
  check(
    'the rule is guarded on the sidebar root actually being there',
    /div:nth-of-type\(1\):has\(\[class\*="_root"\]\)/.test(wide.css),
  );
  check(
    'the sidebar half is gated on Windows, where the root also paints',
    !new RegExp(String.raw`html\[data-dshbg-on\] ${frameSel} > div:nth-of-type\(1\)`).test(wide.css),
  );
  // Dropped in 2.27.2: at `chatSurface: 0` it was a no-op, so it could not be verified,
  // and shipping it next to a real fix made the two indistinguishable. Back only with a
  // replica that exercises a non-zero slider.
  check(
    'the centre column is left alone until it can be verified',
    !new RegExp(String.raw`${frameSel} > div:nth-of-type\(2\):has|${frameSel} > div:nth-of-type\(2\) \{\s*background: transparent`).test(
      wide.css,
    ),
  );
  check(
    'the column rule never names a build-hashed class',
    !/div:nth-of-type\(1\)[^{]*\._?[A-Za-z0-9-]{5,}_/.test(wide.css),
  );
  check(
    'work-area scope leaves the column alone',
    !(await emit({ fullWindow: false })).css.includes('div:nth-of-type(1):has('),
  );

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
  // The banner and the `pre` paint the block's own colour on top; without clearing them
  // the pane is only frosted around an opaque core.
  check('code block banner is cleared', glass.css.includes('[class*="_bannerWrap"]'));
  check('code block pre is cleared', /\[class\*="_block_"\]\:has\(\[data-code-block-banner\]\) pre/.test(glass.css));
  // Two competing routes to the same surface would fight; glass paints directly.
  // The frame-level remix still emits the token, so assert on the card rule specifically.
  check('solid token route dropped in glass mode', !/\[data-composer-card\]\s*\{[^}]*--dsw-specific-input-major/.test(glass.css));
  check('every glass selector is prefixed', !/(^|\})\s*(?:\[|div)/.test(glass.css));
  const glassLow = await emit({ composerStyle: 'glass', glassBlur: 3 });
  check('glass blur is adjustable', glassLow.css.includes('blur(3px) saturate(160%)'));

  // 转写区的表面是内容、不是外壳：输入框切回实心是「输入框」的决定，不该连带把所有
  // 代码块和文件卡也拉回实色。所以这两类与输入框的开关解耦，常开。
  check('solid mode leaves the message box flat', !/\[data-composer-card\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  check('file cards stay glass in solid mode', /\[class\*="_fileCard"\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  check('code blocks stay glass in solid mode', /\[class\*="_block_"\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  check('inline code stays glass in solid mode', /\[class\*="_markdown_"\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  // 用户消息气泡画 --dsw-specific-bubble，同样不在重混列表里。它属于转写区内容，
  // 所以跟着文件卡/代码块一起常开，而不是跟输入框的开关。
  check('user bubble becomes a pane', base.css.includes('[data-chat-flow-kind="user"] [class*="_bubble"]'));
  check(
    'user bubble is frosted, not just tinted',
    /\[data-chat-flow-kind="user"\] \[class\*="_bubble"\][^{]*\{[^}]*backdrop-filter/.test(base.css),
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
  // 输入框卡片：模糊必须挂在 ::before 上，卡片自己不能有 backdrop-filter。
  //
  // 卡片是 `/` 菜单的祖先，卡片一旦有 backdrop-filter 就成了 backdrop root，菜单（挂在
  // 卡片上方 100% + 4px，整个在 root 之外）的模糊就被采样成空白。实测对照页
  // （diag/card-pseudo.html）：卡片自己带模糊时，卡片糊了但**菜单背后清清楚楚**；
  // 模糊挂到 ::before 上时，**卡片和菜单同时糊**。**模糊失效时先查祖先链，别调填充。**
  //
  // 卡片只需要成为 stacking context，让伪元素的 z-index:-1 落在背景之上、内容之下 ——
  // `isolation: isolate` 正好干这个，而且实测**不会**隔离 backdrop 采样。所以这两个属性
  // 一个安全、一个致命，别搞混。
  //
  // 这条必须在「质感 = 液态玻璃」下测：实心模式压根不给卡片套玻璃配方。
  const glassy = await emit({ composerStyle: 'glass' });
  check(
    'composer card carries no backdrop-filter of its own',
    /\[data-composer-card\] \{[^}]*isolation: isolate[\s\S]{0,220}?backdrop-filter: none/.test(
      glassy.css,
    ),
  );
  check(
    'composer card puts the blur on its ::before',
    /\[data-composer-card\]::before \{[^}]*z-index: -1[\s\S]{0,420}?backdrop-filter: blur\((\d{1,2})px\) saturate\(160%\)/.test(
      glassy.css,
    ),
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

  // 这个比例曾经是设置页上的两条**临时滑块**（settings.menuFill / menuBlur），用户在自己
  // 的照片上试出来的结论是 30% / 13px，现在固化成了常量。断言因此翻转：不再是「滑块能改
  // 它」，而是「谁都改不动它」—— 传一个残留的旧设置进去，样式表必须还是常量值。
  const menuStale = await emit({ menuFill: 88, menuBlur: 44, composerStyle: 'glass' });
  check(
    'menu fill is baked, not a setting',
    /\[data-menu-material\][\s\S]{0,120}?\{[^}]*color-mix\(in srgb, var\(--dshbg-raw-l1\) 30%, transparent\)/.test(
      menuStale.css,
    ) && !menuStale.css.includes('var(--dshbg-raw-l1) 76%, transparent'),
  );
  // 模糊半径是同一个故事的第二半：填充和模糊是一对，只调一边等于把问题挪个位置。
  check(
    'menu blur is baked, not a setting',
    menuStale.css.includes('backdrop-filter: blur(13px) saturate(150%)') &&
      !menuStale.css.includes('blur(44px)'),
  );
  // 一处材料一个数字。菜单的 surface、命令菜单、右侧栏三处都读同一个填充，输入框的
  // ::before 也读同一个数——这正是「看着像同一块玻璃」的全部依据，所以数出现次数。
  // 注意 `--dshbg-raw-base 30%` 只有输入框选了液态玻璃才存在，所以这一条要单独 emit。
  check(
    'the whole material shares one fill',
    (menuStale.css.split('var(--dshbg-raw-l1) 30%, transparent').length - 1) >= 3 &&
      menuStale.css.includes('var(--dshbg-raw-base) 30%, transparent'),
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
  // 一屏几十个芯片，模糊半径按最大值算会把 GPU 拖死；上限 10px，够用。
  const chipMax = await emit({ glassBlur: 40 });
  check('inline code chip blur is capped', chipMax.css.includes('blur(10px) saturate(150%)'));

  // 侧栏里的表面（新会话按钮、计费器）跟着侧栏走：只改工作区时侧栏要保持主题原样，
  // 给不透明的面板磨砂没有意义，还会成为这一列里唯一被碰过的元素。
  check('sidebar panes stay flat in work-area scope', !base.css.includes('_newSession'));
  // 用 $= 而不是 *=：按钮的子节点是 _newSessionContent / _newSessionLabel /
  // _newSessionLabelMask / _newSessionShortcut，全含 _newSession 子串，*= 会给它们
  // 各自套一层边框和投影。
  check('sidebar panes frost in whole-window scope', wide.css.includes('[class$="_newSession"]'));
  check('new-session children are not matched', !wide.css.includes('[class*="_newSession"]'));
  check('cost meter card is frosted with the sidebar', wide.css.includes('.cm-footer-stack.summary:not(.rail)'));
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
  check('history block is frosted', /\[class\*="_treeBody"\][\s\S]{0,60}?\{[^}]*backdrop-filter/.test(wide.css));
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
  check('marquee motion is declarative, not WAAPI', !CODE.includes('crumb.animate(') && !CODE.includes('animation.cancel'));
  check('marquee animation is gated on the repeat attribute', /\[data-dshbg-mq\]\s*\{\s*animation: dshbg-marquee/.test(base.css.replace(/\n/g, '')));
  check('marquee distance travels through a custom property', CODE.includes('--dshbg-mq-loop'));
  // 重写自定义属性会让动画从零重新开始 —— 所以只在值真的变了才写。
  check('marquee rewrites the distance only when it changes', CODE.includes("getPropertyValue('--dshbg-mq-loop') !== distance"));
  check('marquee leaves a trace of the computed indent', CODE.includes('MARQUEE_PROBE}.trace'));
  // scrollWidth 不随 text-indent 变化，量它等于没量 —— 只有动画对象自己的 currentTime 能
  // 区分「在滚」「每几帧重启一次」「根本没挂上」。
  check(
    'marquee trace reads the running animation',
    CODE.includes('getAnimations') && CODE.includes('currentTime'),
  );
  check('marquee trace survives a re-install', CODE.includes('let marqueeTrace = null'));
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
  check('marquee leaves its numbers behind', CODE.includes('MARQUEE_PROBE'));
  check('marquee probe is namespaced to the plugin', CODE.includes("'dsh.custom-background.marquee.probe'"));

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
  check('whole-window scope clears the strip outright', wide.css.includes('::before { background: transparent !important; }'));
  check('no orphaned titlebar selector', !base.css.includes('] [data-windows-titlebar]'));
  check('content radius zeroed', base.css.includes('--dsh-windows-content-radius: 0px'));

  console.log('\nsettings page');
  check('the page recipe is driven by the mount marker', base.css.includes('html[data-dshbg-on][data-dshbg-config]'));
  check('both work-area columns are scoped', (base.css.match(/html\[data-dshbg-on\]\[data-dshbg-config\][^{},]*nth-of-type\([23]\)/g) || []).length === 2);
  check('restores theme text on the page', base.css.includes('--dsw-alias-label-primary: var(--dshbg-raw-label-0) !important'));
  check('does not target the centred detail block', !base.css.includes('[data-plugin-detail]'));
  // 设置页从「钉成不透明」翻成「重度磨砂」。这条是用户点名的那个黑框：surface 拉到 0 时，
  // 整窗唯一一张实心黑板就是它。断言必须同时钉住两头 —— 有玻璃配方，且没有退回不透明。
  check(
    'settings page is frosted, not pinned opaque',
    /html\[data-dshbg-on\]\[data-dshbg-config\][^{}]*\{[^}]*color-mix\(in srgb, var\(--dshbg-raw-base\) 82%, transparent\)[^}]*backdrop-filter: blur\(26px\)/.test(
      base.css,
    ),
  );
  check(
    'settings page never falls back to a solid sheet',
    !/html\[data-dshbg-on\]\[data-dshbg-config\][^{}]*\{[^}]*background-color: var\(--dshbg-raw-base\) !important/.test(
      base.css,
    ),
  );
  // Whole-window scope: the sidebar is glass there, so the page must cover it too
  // or the page sits beside a see-through strip.
  const wideConfig = /html\[data-dshbg-on\]\[data-dshbg-config\][^{},]*div:has\(> \[data-shell-overlay\]\)\s*\{/.test(wide.css);
  const wideConfigStillColumnar = /html\[data-dshbg-on\]\[data-dshbg-config\][^{}]*nth-of-type/.test(wide.css);
  check('whole-window scope covers the sidebar as well', wideConfig && !wideConfigStillColumnar);

  console.log('\nauto glass catch-all');
  // 兜底规则：任何被探测器打上标记的元素都按它自己的原色降 alpha 加磨砂。这条规则本身
  // 只是接收方，真正决定打不打标记的是下面那节「detector」。
  check(
    'marked surfaces are frosted from their own colour',
    /\[data-dshbg-auto\] \{[^}]*background-color: color-mix\(in srgb, var\(--dshbg-auto-fill\) 78%, transparent\)[^}]*backdrop-filter: blur\(20px\)/.test(
      base.css,
    ),
  );
  check(
    'the catch-all is conservative, not as clear as a menu',
    /var\(--dshbg-auto-fill\) (\d{1,3})%/.exec(base.css) !== null &&
      Number(/var\(--dshbg-auto-fill\) (\d{1,3})%/.exec(base.css)[1]) > 30,
  );
  // ::backdrop 不是元素，探测器够不到它 —— 所以它只能是 CSS。弹窗本体是玻璃、外面套一圈
  // 死黑，看起来还是黑框。
  check('dialog scrim is lightened globally', base.css.includes('html[data-dshbg-on] dialog::backdrop'));
  check('dialog scrim stays a scrim', /dialog::backdrop \{\s*background: rgb\(0 0 0 \/ \d{1,2}%\)/.test(base.css));

  console.log('\nhost modals');
  // DSH 自带的设置弹窗（ui-settings-general）挂在 `#root` **外面**，面板画的是
  // --dsw-alias-bg-layer-2 —— 在重混列表里，surface=0 时只剩 16%。它背后那个遮罩的
  // --dsw-mask-blur 主题值是 none，也就是**只压暗、完全不磨**。于是正文原样穿过面板。
  // 这一节钉住的是「模态必须有填充 + 模糊」，而不是某个类名。
  // `BASE_SETTINGS.surface` is 20, which is below the modal's floor, so this is the floor
  // value. The three regimes are pinned separately, further down.
  check(
    'a modal panel gets fill and blur',
    /:where\(\[role="dialog"\]\[aria-modal="true"\]\) \{[^}]*color-mix\(in srgb, var\(--dshbg-raw-l2\) 58%, transparent\)[^}]*backdrop-filter: blur\(42px\)/.test(
      base.css,
    ),
  );
  // 模态是浮在「已经压暗过」的背景上的一张卡，所以可以比整页设置更透一点。
  // 这条断言守的是那个关系，不是两个数：谁把模态调到比 SETTINGS_FILL 还实，
  // 就等于把「卡片」当成了「页面」。
  //
  // 取值走上面那个防御式的 `pick()`：规则整条缺失时拿到 NaN，
  // `NaN < x` 为假，于是断言正常报 FAIL 而不是抛异常中断整个 suite。
  const modalBlock = /:where\(\[role="dialog"\]\[aria-modal="true"\]\) \{([^}]*)\}/.exec(base.css);
  const pageBlock = /\[data-dshbg-config\][^{]*\{([^}]*)\}/.exec(base.css);
  const modalFill = pick(modalBlock, /--dshbg-raw-l2\) (\d{1,3})%/);
  const pageFill = pick(pageBlock, /--dshbg-raw-base\) (\d{1,3})%/);
  check(
    'a modal card stays glassier than a full settings page',
    modalFill < pageFill,
    `modal=${modalFill} page=${pageFill}`,
  );
  // 遮罩只压暗不磨，是「字透出来」的另一半 —— 但**不要**顺手把遮罩也磨了：
  // diag/settings-modal.html 上试过，全视口 28px 模糊会把侧栏和正文一起糊成一片，
  // 那是在损失信息，不是在修 bug。磨砂只属于「必须能读」的那个面板。
  check(
    'the scrim is left as a pure dim',
    !/\[aria-hidden="true"\]:has\(\+ \[role="dialog"\]/.test(base.css),
  );
  check(
    'the scrim is still the host\'s own dim',
    !/\[role="dialog"\]\[aria-modal="true"\]\) \{\s*-webkit-backdrop-filter/.test(base.css),
  );
  // 遮罩的 inset 是 `var(--dsh-frame-chrome-top,0px) 0 0`，Windows 下那个值正好等于标题栏
  // 高度 —— 宿主是**故意**不画顶栏的（为了不压暗原生按钮）。压上壁纸之后，那就是一条
  // 横穿窗口的硬边。所以模态打开期间，顶栏那条 ::before 要跟上同样的压暗。
  check(
    'the title bar strip joins the scrim while a modal is open',
    /html\[data-dshbg-on\]:has\(\[role="dialog"\]\[aria-modal="true"\]\) #root div:has\(> \[data-shell-overlay\]\)::before \{[^}]*var\(--dsw-alias-bg-mask-1\)/.test(
      base.css,
    ),
  );
  // 顶栏补的那一层必须是**同一个变量**，不是写死的黑色：遮罩换主题时两边要一起动。
  check(
    'the strip copies the mask token, not a literal',
    !/::before \{[^}]*background-image: linear-gradient\(\s*rgba?\(/.test(base.css),
  );
  // **兜底规则必须输给手写规则。** hook 包在 `:where()` 里，特异性归零，于是这条规则的
  // 特异性只有 `html[data-dshbg-on] body` —— 任何 `.class` 规则都能压过它。
  // cost-meter 的 93% 弹窗就是靠这一点保住自己的数字的。谁把 `:where()` 去掉，这条会炸。
  check(
    'the catch-all carries a zero-specificity hook',
    (base.css.match(/:where\(\[role="dialog"\]\[aria-modal="true"\]\)/g) || []).length === 1,
  );
  check(
    'a hand-written modal recipe still outranks it',
    base.css.includes('body .cm-stat-dialog') && !/cm-stat-dialog[^{]*:where/.test(base.css),
  );
  check(
    'the catch-all is emitted before the specific recipes',
    base.css.indexOf('[aria-modal="true"]') < base.css.indexOf('.cm-stat-dialog'),
  );
  // v2.24.0 的死因：规则指向了一个构建期哈希类名，真机上早就换了，测试还全绿。
  // 这条全局断言把那种写法从根上堵掉 —— 引宿主类名只能引**稳定的一半**（[class*="_menu"]）。
  check(
    'no build-hashed class name anywhere in the sheet',
    !/\.[A-Za-z0-9]{6}_/.test(base.css),
    (/\.[A-Za-z0-9]{6}_/.exec(base.css) || [''])[0],
  );

  // The modal fill is not a fixed number: it tracks the panel slider, with a floor it will
  // not go under and a ceiling it will not pass. Three points are enough to pin all three
  // regimes - below the floor, in the linear band, above the ceiling.
  const modalFillOf = async (surface) => pick(
    /:where\(\[role="dialog"\]\[aria-modal="true"\]\) \{([^}]*)\}/.exec((await emit({ surface })).css),
    /--dshbg-raw-l2\) (\d{1,3})%/,
  );
  check('the modal has a readability floor', (await modalFillOf(0)) === 58, `fill=${await modalFillOf(0)}`);
  check('above the floor the panel slider wins', (await modalFillOf(60)) === 76, `fill=${await modalFillOf(60)}`);
  check('the modal never goes fully solid', (await modalFillOf(100)) === 96, `fill=${await modalFillOf(100)}`);

  // The controls inside the dialog are the other half of "the buttons are not adapted".
  // `--dsw-alias-bg-module-platform` and `--dsw-specific-sidebar-nav-item-active` are opaque
  // neutrals, so on a frosted panel they are the last solid boxes in the dialog. They cannot
  // just be made translucent versions of themselves (see the comment on `modalCss`), so
  // inside the panel they become a veil of the label colour - white in the dark theme,
  // black in the light one, because that token already flips polarity.
  check(
    'selectors and steppers become a veil, not a solid chip',
    /--dsw-alias-bg-module-platform: color-mix\(in srgb, var\(--dshbg-raw-label-0\) 24%, transparent\)/.test(
      base.css,
    ),
  );
  check(
    'the selected nav row gets a slightly stronger veil',
    /--dsw-specific-sidebar-nav-item-active: color-mix\(in srgb, var\(--dshbg-raw-label-0\) 32%, transparent\)/.test(
      base.css,
    ),
  );
  check(
    'the veil is derived from the theme, not from a literal colour',
    !/--dsw-alias-bg-module-platform: (rgb|#)/.test(base.css) && !/--dsw-specific-sidebar-nav-item-active: (rgb|#)/.test(base.css),
  );
  // Scoped on the panel, so it inherits into the dialog and stops there. The app's own
  // sidebar keeps its opaque selected row, and tables / code blocks / badges - which read
  // the same token - are untouched.
  check(
    'the control override exists exactly once, on the panel',
    (base.css.match(/--dsw-alias-bg-module-platform:/g) || []).length === 1 &&
      modalBlock !== null &&
      modalBlock[1].includes('--dsw-alias-bg-module-platform:'),
  );
  check(
    'the nav override does not leak into the app sidebar',
    (base.css.match(/--dsw-specific-sidebar-nav-item-active:/g) || []).length === 1 &&
      modalBlock !== null &&
      modalBlock[1].includes('--dsw-specific-sidebar-nav-item-active:'),
  );

  console.log('\ndetector');
  // 这一节测的是**行为**，不是自己生成的 CSS 字符串。
  //
  // 上一版最贵的教训正在这里：断言测的是我自己吐出来的那串 CSS，选择器早就在新版本里
  // 换掉了，规则一条都没生效，测试却全绿。所以探测器必须在假 DOM 上真的跑一遍，看它
  // 到底给谁打了标记、放过了谁。
  const opaque = { display: 'block', visibility: 'visible', backgroundImage: 'none', backgroundColor: 'rgb(28, 28, 30)' };
  const clearBox = { display: 'block', visibility: 'visible', backgroundImage: 'none', backgroundColor: 'rgba(28, 28, 30, 0.3)' };

  const panel = makeElement('DIV', opaque); // 不透明 + 够大 -> 应该被打标记
  panel._box = { width: 400, height: 300 };
  const smallChip = makeElement('DIV', opaque); // 不透明但太小
  smallChip._box = { width: 40, height: 30 };
  const glassPane = makeElement('DIV', clearBox); // 够大但本来就半透明
  glassPane._box = { width: 400, height: 300 };
  const photo = makeElement('DIV', { ...opaque, backgroundImage: 'linear-gradient(red, blue)' });
  photo._box = { width: 400, height: 300 };
  const picture = makeElement('IMG', opaque); // 图片元素，不是面板
  picture._box = { width: 400, height: 300 };
  const hidden = makeElement('DIV', { ...opaque, visibility: 'hidden' });
  hidden._box = { width: 400, height: 300 };
  const inSettings = makeElement('DIV', opaque); // 设置页内部，有自己的配方
  inSettings._box = { width: 400, height: 300 };
  inSettings.closest = () => ({});

  const nodes = [panel, smallChip, glassPane, photo, picture, hidden, inSettings];
  const probed = await emit({}, { nodes });
  await new Promise((resolve) => setTimeout(resolve, 40));

  check('an opaque panel gets marked', panel.hasAttribute('data-dshbg-auto'));
  check(
    'the mark carries the panel\'s own colour',
    panel.style.getPropertyValue('--dshbg-auto-fill') === 'rgb(28, 28, 30)',
    panel.style.getPropertyValue('--dshbg-auto-fill'),
  );
  check('a small opaque chip is left alone', !smallChip.hasAttribute('data-dshbg-auto'));
  check('an already translucent pane is left alone', !glassPane.hasAttribute('data-dshbg-auto'));
  check('a gradient or photo backdrop is left alone', !photo.hasAttribute('data-dshbg-auto'));
  check('an <img> is left alone', !picture.hasAttribute('data-dshbg-auto'));
  check('a hidden panel is left alone', !hidden.hasAttribute('data-dshbg-auto'));
  check('the settings page keeps its own recipe', !inSettings.hasAttribute('data-dshbg-auto'));
  check('the probe emitted a stylesheet', probed.css.length > 500);

  // 开关必须真的关掉探测器，而不是只改一条 CSS。
  const offNodes = [makeElement('DIV', opaque)];
  offNodes[0]._box = { width: 400, height: 300 };
  await emit({ autoGlass: false }, { nodes: offNodes });
  await new Promise((resolve) => setTimeout(resolve, 40));
  check('the switch stops the detector marking anything', !offNodes[0].hasAttribute('data-dshbg-auto'));

  // 作用域是探测器最容易出错的地方：work-area 模式下壁纸只盖住中间两栏，侧栏是**故意**
  // 留成主题原样的。要是探测器把侧栏里那些不透明面板也磨了，作用域开关就等于被悄悄废掉了。
  // 所以那条界线必须由 `#root` 来划：里面归主题，外面（浮层）才归探测器。
  const innerPanel = makeElement('DIV', opaque);
  innerPanel._box = { width: 400, height: 300 };
  const fakeRoot = makeElement('DIV');
  fakeRoot.contains = (el) => el === innerPanel;
  await emit({ fullWindow: false }, { nodes: [innerPanel], root: fakeRoot });
  await new Promise((resolve) => setTimeout(resolve, 40));
  check('work-area scope leaves the app frame alone', !innerPanel.hasAttribute('data-dshbg-auto'));

  const innerPanelWide = makeElement('DIV', opaque);
  innerPanelWide._box = { width: 400, height: 300 };
  await emit({ fullWindow: true }, { nodes: [innerPanelWide], root: fakeRoot });
  await new Promise((resolve) => setTimeout(resolve, 40));
  check(
    'whole-window scope looks inside the frame too',
    innerPanelWide.hasAttribute('data-dshbg-auto'),
  );

  // 框架整体重写 `style` 时会抹掉内联的自定义属性、留下 `data-dshbg-auto` 属性。此时
  // 再去读计算值毫无意义（我们自己的规则已经生效，`color-mix` 无效，报的是 transparent），
  // 只有记下来的原色是可信的。这条断言钉住「标记不会因为一次重渲染就变成全透明」。
  panel.style.removeProperty('--dshbg-auto-fill');
  check('a wiped colour is really gone', panel.style.getPropertyValue('--dshbg-auto-fill') === '');
  const detector = probed.observers[probed.observers.length - 1];
  detector.fire();
  await new Promise((resolve) => setTimeout(resolve, 320));
  check(
    'the mark restores its colour after a re-render',
    panel.style.getPropertyValue('--dshbg-auto-fill') === 'rgb(28, 28, 30)',
    panel.style.getPropertyValue('--dshbg-auto-fill'),
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
  check('panels retargeted', base.css.includes('html[data-dshbg-on] body .cm-section'));
  check('dialogs retargeted', base.css.includes('html[data-dshbg-on] body .cm-stat-dialog'));
  check('dialog group is one rule', /\.cm-stat-dialog,\nhtml\[data-dshbg-on\] body \.cm-qguide/.test(base.css));
  check('modal backdrop dimmed', base.css.includes('.cm-stat-dialog::backdrop'));

  console.log('\nlifecycle');
  const off = await emit({ mode: 'none' });
  check('mode none injects an empty stylesheet', off.css === '', `length ${off.css.length}`);
  // The marquee's `text-overflow: clip` rides the same sheet, so switching the background
  // off has to take it with it - otherwise a scrolling title keeps its ellipsis pinned.
  check('title clip goes away with the stylesheet', !off.css.includes('_crumb'));
  check('mode none leaves <html> unmarked', !off.documentElement.hasAttribute('data-dshbg-on'));
  check('mode none still registers the slot', off.registered.length === 1);

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
  // 临时滑块已经拆掉，数字固化进常量。断言跟着翻转，并且留一条反向的：防止有人日后
  // 又把「（临时）」控件加回来 —— 那是这套东西里最容易被当成「先放个开关」的入口。
  check('temporary sliders are gone', !blob.includes('（临时）') && !blob.includes('(temporary)'));
  check('auto glass catch-all switch is on the page', blob.includes('自动玻璃'));

  console.log('\nslot registration');
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
      if (selector.length > 0) selectors.push(selector);
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
  // `--dump --css-out=<path> --settings=<json>`: write the sheet for an arbitrary set of
  // settings. The replica pages under `diag/` need the *real* output for the *user's* real
  // numbers - a bug that only appears at `surface: 0` cannot be reproduced from the
  // defaults, and hand-editing a dumped sheet would defeat the point of the replica.
  if (CSS_OUT !== null) {
    const custom = await emit(OVERRIDES);
    fs.writeFileSync(CSS_OUT, custom.css, 'utf8');
    console.log(`\n--- wrote ${custom.css.length} bytes to ${CSS_OUT} ---`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});
