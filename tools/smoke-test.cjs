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
  chatSurface: 78,
  composerSurface: 85,
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
  const headerRe = /(?:^|\})\s*([^{}]+)\{/g;
  let match;
  while ((match = headerRe.exec(base.css)) !== null) {
    for (const part of match[1].split(',')) {
      const selector = part.trim();
      if (selector.length > 0) selectors.push(selector);
    }
  }
  const unscoped = selectors.filter((selector) => !selector.startsWith('html[data-dshbg-on]'));
  check('every selector carries the activation prefix', unscoped.length === 0, unscoped.slice(0, 3).join(' | '));
  check('selector scan saw the whole sheet', selectors.length >= 18, `parsed ${selectors.length}`);

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
