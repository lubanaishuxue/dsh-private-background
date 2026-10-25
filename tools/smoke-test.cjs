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
    textContent: '',
    children: [],
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
function harness(settingsOverride) {
  const settings = { ...BASE_SETTINGS, ...settingsOverride };
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
    getComputedStyle() { return { backgroundImage: 'none' }; },
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

  return { definition, ctx, registered, documentElement, head };
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
async function emit(settingsOverride) {
  const run = harness(settingsOverride);
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
  // 会话里只有第一条用户消息是 flow-kind="user"；中途追加的提示词是 `steering`，排队跟进的
  // 是 `turn-trigger`。只认 user 就会得到「只有第一句有玻璃」。
  check(
    'follow-up prompts get the same bubble glass',
    base.css.includes('[data-chat-flow-kind="steering"] [class*="_bubble"]') &&
      base.css.includes('[data-chat-flow-kind="turn-trigger"] [class*="_bubble"]') &&
      base.css.includes('[class*="_userRow"] [class*="_bubble"]'),
  );
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

  // 这个比例目前是设置页上的**临时滑块**（settings.menuFill），所以上面几条只校验
  // 「有填充、带百分号」。这条单独校验滑块真的驱动了样式表 —— 它的意义在于：滑块拆掉、
  // 数字固化之后，如果谁把 menuSurfaceCss 改回写死字面量，上面几条照样会过（因为
  // DEFAULTS.menuFill 恰好等于那个数），只有这条会炸。
  const menu88 = await emit({ menuFill: 88 });
  check(
    'menu fill follows the slider',
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
  // 整窗模式的通栏只承担「同样的色」，不加模糊：它下面的栏是 token 重混（只有颜色、没有
  // 模糊），通栏一片糊、下面一片清，边界反而更跳。左半按侧栏浓度、右半按对话区浓度，
  // 在 --dsh-windows-sidebar-width 处硬断；侧栏收起时该变量为 0，整条自然变成工作区色。
  check(
    'whole-window strip tints like the columns it continues',
    /::before \{ background: linear-gradient\(to right,[\s\S]{0,260}?var\(--dshbg-raw-sidebar\) 30%, transparent\) 0,[\s\S]{0,260}?var\(--dshbg-raw-sidebar\) 30%, transparent\) var\(--dsh-windows-sidebar-width, 0px\),[\s\S]{0,260}?var\(--dshbg-raw-base\) 78%, transparent\) var\(--dsh-windows-sidebar-width, 0px\)\) !important; \}/.test(
      wide.css,
    ),
  );
  check('whole-window strip does not blur what it covers', !/::before \{[\s\S]{0,400}?backdrop-filter/.test(wide.css));
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
  check('changed-files card becomes a pane', /\[data-changed-files\][^{]*\{[^}]*backdrop-filter/.test(base.css));
  check('changed-files header stops painting black', /\[data-changed-files\] \{[^}]*--changes-fill: transparent/.test(base.css));
  check(
    'cost dialogs are glass instead of near-opaque',
    /\.cm-stat-dialog[\s\S]{0,200}?var\(--dshbg-raw-l2\) 58%, transparent[\s\S]{0,300}?backdrop-filter: blur\(/.test(base.css),
  );
  check(
    'an open dialog pushes the app back',
    /:has\(\[role="dialog"\]\[aria-modal="true"\]\) #root[\s\S]{0,120}?filter: blur\(\d+px\) brightness\(0\.52\)/.test(
      base.css,
    ),
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
  // 第二个座位是侧栏的临时调参卡。它和设置页互不依赖：任何一边缺失都不能把另一边带崩。
  check('mode none still registers both seats', off.registered.length === 2, `got ${off.registered.length}`);

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
  // 临时滑块。它们是要被拆掉的东西，但拆之前必须真的出现在页面上 —— 否则用户找不到。
  check('temporary glass blur slider is on the page', blob.includes('玻璃模糊（临时）'));
  check('temporary glass fill slider is on the page', blob.includes('玻璃填充（临时）'));
  // 调参卡的总开关在插件页：数值定稿后从界面关掉即可，不用删代码。
  check(
    'the tuning card can be switched off from the plugin page',
    blob.includes('显示左侧调参栏') && CODE.includes('showDock: true') && CODE.includes('settings.showDock === false'),
  );

  console.log('\nsidebar tuning dock');
  // 侧栏那张卡：默认只渲染一行折叠头，展开后才滑杆。标签写错只会在应用里炸，所以真渲染一次。
  let dock = null;
  try {
    dock = base.registered[1].component({});
  } catch (failure) {
    dock = null;
  }
  check('dock renders without throwing', dock !== null);
  const beforeDock = strings.length;
  walk(dock);
  const dockBlob = strings.slice(beforeDock).join('\n');
  check('dock shows a collapsed header', dockBlob.includes('调参（临时）'), dockBlob.slice(0, 60));
  check(
    'dock carries every dial',
    ['blur', 'dim', 'surface', 'chatSurface', 'composerSurface', 'glassBlur', 'menuFill', 'menuBlur', 'sidebarFill'].every(
      (key) => CODE.includes(`key: '${key}'`),
    ),
  );
  check('dock can read back computed values', CODE.includes('function probeSurface') && CODE.includes('getComputedStyle'));
  // 亮壁纸上最容易翻车的不是玻璃参数，是「白字压亮图」：极性开关必须从侧栏就能切。
  check('dock can flip text polarity', CODE.includes("settings.font === 'auto'") && CODE.includes("font: 'auto'"));
  check('dock can restore a legible baseline', CODE.includes('const RECOMMENDED') && CODE.includes('...RECOMMENDED'));

  console.log('\nslot registration');
  check('two slot registrations', base.registered.length === 2, `got ${base.registered.length}`);
  if (base.registered.length > 0) {
    const { options } = base.registered[0];
    check('registers into plugins.bundle.config', options.name === 'plugins.bundle.config');
    check('keyed by the package name', options.key === '@local/dsh-custom-background', options.key);
  }
  if (base.registered.length > 1) {
    const { options } = base.registered[1];
    check('tuner docks into the sidebar foot', options.name === 'sidebar.footer.action', options.name);
    check('tuner has its own id', options.id === 'custom-background-tuner', options.id);
    check('config page is registered first', base.registered[0].options.name === 'plugins.bundle.config');
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
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});
