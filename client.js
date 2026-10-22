/**
 * @local/dsh-custom-background - browser half.
 *
 * Paints a wallpaper behind the DSH shell and renders its control panel into the
 * plugin-manager detail page. Nothing here talks to the model, the session log or any
 * host service; the whole feature is a stylesheet plus a small React form.
 *
 * ARCHITECTURE
 *
 *   html::before   the wallpaper itself (fixed, cover, blurred)
 *   html::after    the dimming veil
 *   body           captures the theme's surface tokens as raw values
 *   frame          re-mixes those tokens with transparency, so every surface painted
 *                  from a token turns to glass and the wallpaper shows through
 *
 * Scope is expressed by *omission*, not by overrides: the sidebar column paints
 * `--dsw-specific-sidebar-fill`, so leaving that one token untouched keeps the
 * conversation sidebar exactly as the theme drew it. "Whole window" simply adds it to
 * the re-mix list.
 *
 * The settings page is the one place that must stay opaque - a wallpaper behind a
 * heading is unreadable. That is driven by a marker the config component sets on
 * <html> while it is mounted, so the stylesheet never has to guess where the page is.
 *
 * Everything below is written against three structural facts taken from the host's
 * layout module, not against hashed class names:
 *   - the frame is `#root div:has(> [data-shell-overlay])`
 *   - its three column divs are the first three div children (DocumentTitle renders no
 *     element), so nth-of-type(1|2|3) = sidebar | center | rightbar
 *   - the bottom status bar carries `data-shell-bottom`
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-custom-background',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    const PACKAGE = '@local/dsh-custom-background';
    const SETTINGS_KEY = 'dsh.custom-background.settings.v3';
    const DB_NAME = 'dsh-custom-background';
    const DB_STORE = 'images';
    const MAX_EDGE = 2560;
    const MAX_DATA_URL = 3_600_000;

    // ------------------------------------------------------------------ defaults

    const DEFAULTS = {
      mode: 'none',
      imageId: null,
      gradient: 0,
      color: '#1b2233',
      blur: 14,
      dim: 30,
      surface: 55,
      chatSurface: 78,
      composerSurface: 85,
      composerStyle: 'solid',
      glassBlur: 14,
      fullWindow: false,
      font: 'theme',
      fontColor: '#f7f8fa',
    };

    const GRADIENTS = [
      { zh: '极光', en: 'Aurora', css: 'linear-gradient(135deg, #0f2027 0%, #203a43 46%, #2c5364 100%)' },
      { zh: '夜幕', en: 'Midnight', css: 'radial-gradient(120% 120% at 22% 12%, #1d2b4f 0%, #10141f 62%, #070910 100%)' },
      { zh: '落日', en: 'Sunset', css: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 48%, #fbc2eb 100%)' },
      { zh: '深海', en: 'Abyss', css: 'linear-gradient(160deg, #0b1a2b 0%, #12324a 55%, #1c5a72 100%)' },
      { zh: '青柠', en: 'Lime', css: 'linear-gradient(135deg, #a8ff78 0%, #78ffd6 100%)' },
      { zh: '纸感', en: 'Paper', css: 'linear-gradient(135deg, #f6f4ef 0%, #e9e3d8 100%)' },
    ];

    const SWATCHES = ['#1b2233', '#0d1117', '#12324a', '#2b2135', '#f3efe7', '#e8eef7'];

    const FONT_PALETTES = {
      light: {
        primary: '#f7f8fa',
        secondary: '#d9dee6',
        tertiary: '#b8bfc9',
        caption: '#a6adb8',
        dimmed: '#c9cfd8',
        primaryDimmed: '#e3e7ee',
      },
      dark: {
        primary: '#12161d',
        secondary: '#3a4150',
        tertiary: '#5b6472',
        caption: '#6c7583',
        dimmed: '#4a5260',
        primaryDimmed: '#2a3140',
      },
    };

    const TEXT = {
      zh: {
        title: '界面背景',
        subtitle: '把 DSH 的底色换成自己的图。图片只存在这台电脑上，不会上传。',
        preview: '效果预览',
        previewSample: '正文示例 · 标题与消息都会跟着变',
        previewPanel: '面板',
        type: '背景类型',
        modes: { none: '关闭', image: '图片', gradient: '渐变', color: '纯色' },
        gallery: '背景图库',
        galleryHint: '点一张图立即切换；图库里的图都保存在本机。',
        add: '添加图片',
        empty: '还没有图片。点「添加图片」选一张。',
        gradient: '渐变',
        color: '纯色',
        customColor: '自选颜色',
        scope: '作用范围',
        fullWindow: '同时应用到左侧对话栏',
        fullWindowHint: '关掉时只有工作区换背景，左侧对话列表保持原样；打开则整窗铺满。',
        font: '字体颜色',
        fonts: { theme: '跟随主题', auto: '自动', light: '浅色', dark: '深色', custom: '自定义' },
        fontHint: '「自动」按背景实际明暗选黑或白；「跟随主题」不做任何改动。',
        customFont: '自选颜色',
        blur: '模糊',
        dim: '压暗',
        surface: '面板不透明度',
        surfaceHint: '调低背景更明显；文字发虚时把它调高。',
        chatSurface: '对话区不透明度',
        chatSurfaceHint: '对话区单独一档。看字吃力就往上拉，想多露点壁纸就往下拉。',
        composerSurface: '输入框不透明度',
        composerSurfaceHint: '发消息那个框单独一档。框里的字发虚就往上拉。',
        glass: '质感',
        glassSolid: '实心',
        glassLiquid: '液态玻璃',
        glassHint: '液态玻璃让输入框、底部状态栏、头部胶囊、代码块、文件卡片、消息气泡一起变磨砂半透明，边缘带一道高光。字压在图上更容易读，因为背景被磨平了。',
        glassHintSolid: '实心：各自按上面的不透明度铺底色，没有模糊和高光。',
        glassBlur: '玻璃模糊',
        reset: '恢复默认',
        autoSaved: '改动即时生效并自动保存',
        diagnostics: '样式 / 激活 / 框架 / 三栏',
        toneLight: '深色背景 → 浅色字',
        toneDark: '浅色背景 → 深色字',
        broken: '没定位到 DSH 的外壳结构，背景无法铺开，但不会影响其他界面。请把这行告诉我。',
        tooLarge: '这张图太大，换一张小一点的试试。',
        readFail: '读取图片失败。',
        remove: '删除',
      },
      en: {
        title: 'Interface background',
        subtitle: 'Replace the DSH base colour with your own artwork. Images stay on this machine.',
        preview: 'Preview',
        previewSample: 'Body text sample - headings and messages follow',
        previewPanel: 'Panel',
        type: 'Background type',
        modes: { none: 'Off', image: 'Image', gradient: 'Gradient', color: 'Solid' },
        gallery: 'Gallery',
        galleryHint: 'Click an image to switch to it. Everything is stored locally.',
        add: 'Add image',
        empty: 'No images yet. Use "Add image" to pick one.',
        gradient: 'Gradient',
        color: 'Solid colour',
        customColor: 'Custom colour',
        scope: 'Scope',
        fullWindow: 'Also apply to the conversation sidebar',
        fullWindowHint: 'Off: only the work area changes and the sidebar keeps its own look. On: the wallpaper fills the window.',
        font: 'Text colour',
        fonts: { theme: 'Theme', auto: 'Auto', light: 'Light', dark: 'Dark', custom: 'Custom' },
        fontHint: '"Auto" picks black or white from the background. "Theme" leaves text untouched.',
        customFont: 'Custom colour',
        blur: 'Blur',
        dim: 'Dim',
        surface: 'Panel opacity',
        surfaceHint: 'Lower values reveal more of the wallpaper; raise it if text gets muddy.',
        chatSurface: 'Conversation opacity',
        chatSurfaceHint: 'Its own setting for the conversation area. Raise it when reading is hard, lower it to show more wallpaper.',
        composerSurface: 'Composer opacity',
        composerSurfaceHint: 'Its own setting for the message box. Raise it if the text you are typing looks washed out.',
        glass: 'Surface finish',
        glassSolid: 'Solid',
        glassLiquid: 'Liquid glass',
        glassHint: 'Liquid glass turns the message box, the status row, the header chips, code blocks, file cards and message bubbles into frosted panes with a lit edge. Text stays readable because the backdrop is flattened, not just dimmed.',
        glassHintSolid: 'Solid: each surface just fills with its own opacity - no blur, no highlight.',
        glassBlur: 'Glass blur',
        reset: 'Reset',
        autoSaved: 'Changes apply and save immediately',
        diagnostics: 'style / active / frame / columns',
        toneLight: 'Dark background, light text',
        toneDark: 'Light background, dark text',
        broken: 'Could not locate the DSH shell, so the wallpaper cannot paint. Nothing else is affected. Please report this line.',
        tooLarge: 'That image is too large. Try a smaller one.',
        readFail: 'Could not read that image.',
        remove: 'Remove',
      },
    };

    // --------------------------------------------------------------------- utils

    function clamp(value, low, high) {
      const number = Number(value);
      if (!Number.isFinite(number)) return low;
      return Math.min(high, Math.max(low, number));
    }

    function currentLang() {
      const raw = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
      return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    // ---------------------------------------------------------------- persistence

    function readSettings() {
      const fallback = { ...DEFAULTS };
      let parsed = null;
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        parsed = raw === null ? null : JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed === null || typeof parsed !== 'object') return fallback;

      const modes = ['none', 'image', 'gradient', 'color'];
      const fonts = ['theme', 'auto', 'light', 'dark', 'custom'];
      return {
        mode: modes.includes(parsed.mode) ? parsed.mode : fallback.mode,
        imageId: typeof parsed.imageId === 'string' ? parsed.imageId : null,
        gradient: clamp(parsed.gradient === undefined ? 0 : parsed.gradient, 0, GRADIENTS.length - 1),
        color: typeof parsed.color === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.color) ? parsed.color : fallback.color,
        blur: clamp(parsed.blur === undefined ? fallback.blur : parsed.blur, 0, 40),
        dim: clamp(parsed.dim === undefined ? fallback.dim : parsed.dim, 0, 80),
        surface: clamp(parsed.surface === undefined ? fallback.surface : parsed.surface, 0, 100),
        chatSurface: clamp(
          parsed.chatSurface === undefined ? fallback.chatSurface : parsed.chatSurface,
          0,
          100,
        ),
        composerSurface: clamp(
          parsed.composerSurface === undefined ? fallback.composerSurface : parsed.composerSurface,
          0,
          100,
        ),
        composerStyle: parsed.composerStyle === 'glass' ? 'glass' : 'solid',
        glassBlur: clamp(parsed.glassBlur === undefined ? fallback.glassBlur : parsed.glassBlur, 0, 40),
        fullWindow: parsed.fullWindow === true,
        font: fonts.includes(parsed.font) ? parsed.font : fallback.font,
        fontColor:
          typeof parsed.fontColor === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.fontColor)
            ? parsed.fontColor
            : fallback.fontColor,
      };
    }

    function writeSettings(settings) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        // A full or disabled store only costs persistence; the session keeps working.
      }
    }

    // -------------------------------------------------------------- image storage

    function openDb() {
      return new Promise((resolve, reject) => {
        const request = window.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('indexeddb'));
      });
    }

    function dbRun(mode, run) {
      return openDb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const transaction = db.transaction(DB_STORE, mode);
            const request = run(transaction.objectStore(DB_STORE));
            transaction.oncomplete = () => resolve(request === undefined ? undefined : request.result);
            transaction.onerror = () => reject(transaction.error || new Error('idb-transaction'));
            transaction.onabort = () => reject(transaction.error || new Error('idb-abort'));
          }),
      );
    }

    const listImageRecords = () => dbRun('readonly', (store) => store.getAll());
    const putImageRecord = (record) => dbRun('readwrite', (store) => store.put(record));
    const deleteImageRecord = (id) => dbRun('readwrite', (store) => store.delete(id));

    /** Read a picked file and shrink it so a 4K photo does not blow the local quota. */
    function ingestFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read'));
        reader.onload = () => {
          const source = String(reader.result);
          const image = new Image();
          image.onerror = () => reject(new Error('decode'));
          image.onload = () => {
            try {
              const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(image.width * scale));
              canvas.height = Math.max(1, Math.round(image.height * scale));
              canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
              let quality = 0.88;
              let dataUrl = canvas.toDataURL('image/jpeg', quality);
              while (dataUrl.length > MAX_DATA_URL && quality > 0.42) {
                quality -= 0.1;
                dataUrl = canvas.toDataURL('image/jpeg', quality);
              }
              if (dataUrl.length > MAX_DATA_URL) reject(new Error('too-large'));
              else resolve(dataUrl);
            } catch (failure) {
              reject(failure);
            }
          };
          image.src = source;
        };
        reader.readAsDataURL(file);
      });
    }

    // ---------------------------------------------------------------- luminance

    /**
     * What the text actually sits on: wallpaper -> dimmed -> veiled by the panel.
     * A single pure function of the settings, so the tone it drives can never feed back
     * into the measurement and oscillate.
     */
    const PANEL_LUMA = 46;
    const TONE_THRESHOLD = 140;
    const SAMPLE_W = 16;
    const SAMPLE_H = 9;

    function lumaOfCss(css) {
      const stops = String(css).match(/#[0-9a-f]{6}/gi);
      if (stops === null || stops.length === 0) return null;
      let sum = 0;
      for (const stop of stops) {
        const value = parseInt(stop.slice(1), 16);
        // Rec.601: the eye weights green far above blue, so a flat channel average
        // would call a blue sky "dark" and pick white text for it.
        sum += 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
      }
      return sum / stops.length;
    }

    function lumaOfImage(dataUrl) {
      return new Promise((resolve) => {
        const image = new Image();
        image.onerror = () => resolve(null);
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = SAMPLE_W;
            canvas.height = SAMPLE_H;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context === null) {
              resolve(null);
              return;
            }
            context.drawImage(image, 0, 0, SAMPLE_W, SAMPLE_H);
            const { data } = context.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
              sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            }
            resolve(sum / (data.length / 4));
          } catch {
            resolve(null);
          }
        };
        image.src = dataUrl;
      });
    }

    async function measureLuma(settings, activeImage) {
      let base = null;
      if (settings.mode === 'gradient') base = lumaOfCss(GRADIENTS[settings.gradient].css);
      else if (settings.mode === 'color') base = lumaOfCss(settings.color);
      else if (settings.mode === 'image' && activeImage !== null) base = await lumaOfImage(activeImage);
      if (base === null) return null;

      const dimFactor = 1 - clamp(settings.dim, 0, 80) / 100;
      const panelMix = clamp(settings.surface, 0, 100) / 100;
      return base * dimFactor * (1 - panelMix) + PANEL_LUMA * panelMix;
    }

    /** Pure: the same luma always yields the same tone. No hysteresis, no feedback. */
    function toneOf(luma) {
      if (luma === null) return 'light';
      return luma > TONE_THRESHOLD ? 'dark' : 'light';
    }

    // -------------------------------------------------------------------- store

    let state = {
      settings: readSettings(),
      activeImage: null,
      images: null,
      luma: null,
      ready: false,
    };
    const listeners = new Set();

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function getSnapshot() {
      return state;
    }

    function emit() {
      for (const listener of listeners) listener();
    }

    function commit(patch) {
      state = { ...state, ...patch };
      emit();
    }

    function patchSettings(patch) {
      state = { ...state, settings: { ...state.settings, ...patch } };
      writeSettings(state.settings);
      emit();
    }

    let booted = false;
    function boot() {
      if (booted) return;
      booted = true;
      listImageRecords()
        .then((records) => {
          const images = Array.isArray(records) ? records : [];
          const settings = state.settings;
          const active = images.find((record) => record.id === settings.imageId) || null;
          commit({ images, activeImage: active === null ? null : active.dataUrl, ready: true });
        })
        .catch(() => commit({ images: [], activeImage: null, ready: true }));
    }

    async function addImage(file) {
      const dataUrl = await ingestFile(file);
      const record = { id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dataUrl, addedAt: Date.now() };
      await putImageRecord(record);
      const images = (state.images === null ? [] : state.images).concat(record);
      commit({ images, activeImage: dataUrl });
      patchSettings({ mode: 'image', imageId: record.id });
      return record;
    }

    async function removeImage(id) {
      await deleteImageRecord(id);
      const wasActive = state.settings.imageId === id;
      const images = (state.images === null ? [] : state.images).filter((record) => record.id !== id);
      commit({ images, activeImage: wasActive ? null : state.activeImage });
      if (wasActive) {
        patchSettings({ imageId: null, mode: state.settings.mode === 'image' ? 'none' : state.settings.mode });
      }
    }

    // ------------------------------------------------------------------ selectors

    function frameSelector() {
      return '#root div:has(> [data-shell-overlay])';
    }

    /**
     * Center + rightbar: everything that is *not* the conversation sidebar.
     *
     * Returned as a list rather than a joined string, because a comma list cannot be
     * given a shared prefix later - `html[on] a, b` scopes only `a` and leaves `b` as a
     * bare selector that matches unconditionally. Every caller must go through
     * `prefixed()`.
     */
    function workAreaColumns() {
      const frame = frameSelector();
      return [`${frame} > div:nth-of-type(2)`, `${frame} > div:nth-of-type(3)`];
    }

    /** Repeat a prefix for every selector in the list. See `workAreaColumns`. */
    function prefixed(prefix, selectors) {
      return selectors.map((selector) => `${prefix} ${selector}`).join(',\n');
    }

    function bottomRowSelector() {
      return `${frameSelector()} > [data-shell-bottom]`;
    }

    // --------------------------------------------------------------------- tokens

    /**
     * Every token that paints a surface. `lift` keeps elevation legible: a raised panel
     * is re-mixed slightly more opaque than the surface under it, so stacked panels
     * still read as stacked instead of dissolving into one sheet.
     *
     * `sidebarOnly` marks the one token that belongs to the conversation sidebar. It is
     * deliberately *not* re-mixed unless the user asks for a whole-window background,
     * which is what keeps the sidebar untouched by default.
     */
    const SURFACE_TOKENS = [
      { token: '--dsw-alias-bg-base', raw: 'base', lift: 0 },
      { token: '--dsw-specific-sidebar-fill', raw: 'sidebar', lift: 0, sidebarOnly: true },
      { token: '--dsw-alias-bg-layer-1', raw: 'l1', lift: 8 },
      { token: '--dsw-specific-input-major', raw: 'input', lift: 8 },
      { token: '--dsw-specific-selector', raw: 'selector', lift: 8 },
      { token: '--dsw-alias-bg-layer-2', raw: 'l2', lift: 16 },
      { token: '--dsw-alias-bg-layer-3', raw: 'l3', lift: 16 },
      { token: '--dsw-alias-bg-layer-4', raw: 'l4', lift: 16 },
      { token: '--dsw-alias-button-tool-bar-fill', raw: 'toolbar', lift: 16 },
    ];

    const LABEL_TOKENS = [
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-label-caption',
      '--dsw-alias-label-dimmed',
      '--dsw-alias-label-primary-dimmed',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-border-l3',
    ];

    // ------------------------------------------------------------------------ css

    function backgroundValue(settings, activeImage) {
      if (settings.mode === 'image') return activeImage === null ? null : `url("${activeImage}")`;
      if (settings.mode === 'gradient') return GRADIENTS[settings.gradient].css;
      if (settings.mode === 'color') return `linear-gradient(${settings.color}, ${settings.color})`;
      return null;
    }

    function wallpaperCss(settings, value) {
      const bleed = Math.round(settings.blur * 2 + 12);
      return `
html[data-dshbg-on] { background: transparent !important; }
html[data-dshbg-on] body,
html[data-dshbg-on] #root,
html[data-dshbg-on] ${frameSelector()} { background: transparent !important; }
html[data-dshbg-on]::before {
  content: "";
  position: fixed;
  inset: -${bleed}px;
  z-index: -1;
  pointer-events: none;
  background-image: ${value};
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(${settings.blur}px);
  transform: translateZ(0);
}
html[data-dshbg-on]::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-color: rgb(0 0 0 / ${(settings.dim / 100).toFixed(3)});
}
`;
    }

    function tokenCss(settings) {
      const captures = SURFACE_TOKENS.map((entry) => `  --dshbg-raw-${entry.raw}: var(${entry.token});`).join('\n');
      const labelCaptures = LABEL_TOKENS.map((token, index) => `  --dshbg-raw-label-${index}: var(${token});`).join('\n');
      const remixes = SURFACE_TOKENS.filter((entry) => settings.fullWindow || entry.sidebarOnly !== true)
        .map((entry) => {
          const alpha = Math.min(100, clamp(settings.surface, 0, 100) + entry.lift);
          return `  ${entry.token}: color-mix(in srgb, var(--dshbg-raw-${entry.raw}) ${alpha}%, transparent) !important;`;
        })
        .join('\n');
      return `
html[data-dshbg-on] body {
${captures}
${labelCaptures}
}
html[data-dshbg-on] ${frameSelector()} {
${remixes}
}
`;
    }

    /**
     * The conversation column gets its own opacity.
     *
     * Reading long text over artwork needs a steadier backdrop than the panels do, and
     * the two wants pull in opposite directions: the chrome should stay glassy, the
     * transcript should stay legible. One shared slider forces a compromise, so this
     * column overrides `--dsw-alias-bg-base` locally instead of stacking a second layer
     * on top of the one the conversation root already paints - two translucent layers
     * would compose to something neither number describes.
     *
     * `> div:nth-of-type(2)` is the center column (the same structural anchor the settings
     * page rule uses), so this survives the hashed class names inside the conversation.
     */
    function chatSurfaceCss(settings) {
      const alpha = clamp(settings.chatSurface, 0, 100);
      return `
html[data-dshbg-on] ${frameSelector()} > div:nth-of-type(2) {
  --dsw-alias-bg-base: color-mix(in srgb, var(--dshbg-raw-base) ${alpha}%, transparent) !important;
}
`;
    }

    /**
     * The message box gets its own opacity too.
     *
     * `[data-composer-card]` is the element that paints `background: var(--dsw-specific-input-major)`,
     * so overriding that one token *on that element* is enough - a custom property declared
     * on an element applies to that element's own declarations as well, which is why no
     * separate `background` rule is needed here.
     *
     * This is the one surface where the wallpaper is least welcome: it sits directly under
     * the text being typed, and a bright patch behind the placeholder makes it read as a
     * rendering glitch rather than as a design choice.
     */
    function composerCss(settings) {
      // Glass mode paints the composer directly, so a second token override would just
      // fight it. Solid mode keeps the token route.
      if (settings.composerStyle === 'glass') return '';
      const alpha = clamp(settings.composerSurface, 0, 100);
      return `
html[data-dshbg-on] [data-composer-card] {
  --dsw-specific-input-major: color-mix(in srgb, var(--dshbg-raw-input) ${alpha}%, transparent) !important;
}
`;
    }

    /**
     * The frosted-pane recipe, shared by every surface that gets the liquid-glass look.
     *
     * The wallpaper is already blurred at the `html::before` layer, so the pane's own
     * `backdrop-filter` mostly adds saturation and edge definition rather than doing the
     * blurring work. That is deliberate: it keeps the GPU cost of a long transcript with
     * many blocks low while still reading as glass.
     */
    function glassPane(blur) {
      return `  background-color: color-mix(in srgb, var(--dshbg-raw-base) 22%, transparent) !important;
  border: 1px solid color-mix(in srgb, var(--dshbg-raw-label-0) 16%, transparent) !important;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    inset 0 -1px 0 0 rgb(0 0 0 / 0.10),
    0 10px 30px -14px rgb(0 0 0 / 0.55) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(160%) !important;
  backdrop-filter: blur(${blur}px) saturate(160%) !important;`;
    }

    /**
     * The small-pane variant, for inline code.
     *
     * Same idea, three differences, all of them about being 20px tall and appearing dozens
     * of times in one screen:
     *
     * - More fill (45% against the pane's 22%). Inline code has to stay distinguishable
     *   from the prose around it; at 22% it dissolves into the wallpaper and the monospace
     *   run stops reading as a token. 45% is where 12px monospace in the light label colour
     *   still clears 5:1 against a mid-bright wallpaper - below that the chips are pretty
     *   but unreadable, which is the one thing a code token cannot be.
     * - No drop shadow, only the top inner highlight. Fifteen floating shadows in a
     *   paragraph is noise, and the hairline border already lifts the chip off the page.
     * - The border stays at the host's `.5px`, only its colour changes. Going to 1px would
     *   add 1px to every chip's box, and these are inline elements - a hundred of them in
     *   one paragraph is a hundred little reflows of the line they sit on.
     * - Blur capped at 10px. The backdrop is already blurred at the `html::before` layer,
     *   so a bigger radius buys nothing visually while multiplying the cost by the number
     *   of chips on screen.
     *
     * `border` is a parameter rather than a constant because the same recipe is reused on
     * block-level buttons (the cost-detail pills), where the host already draws a 1px
     * border and shrinking it to .5px would visibly thin an edge that is not inline.
     */
    function glassChip(blur, border = '.5px') {
      const radius = Math.min(blur, 10);
      return `  background-color: color-mix(in srgb, var(--dshbg-raw-base) 45%, transparent) !important;
  border: ${border} solid color-mix(in srgb, var(--dshbg-raw-label-0) 14%, transparent) !important;
  box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.08) !important;
  -webkit-backdrop-filter: blur(${radius}px) saturate(150%) !important;
  backdrop-filter: blur(${radius}px) saturate(150%) !important;`;
    }

    /**
     * A control that floats *over* the transcript - the jump-to-bottom disc.
     *
     * `glassPane` is the wrong strength here. A pane sits in a column where the only thing
     * behind it is wallpaper; this disc sits on top of message text, and at 22% the text
     * underneath reads straight through it. It also keeps its drop shadow, because it is the
     * one control in the transcript that has to look lifted off the page rather than part of
     * it - the host's `--dsw-elevation-panel` goes away the moment a recipe replaces the
     * box-shadow, so the shadow has to be re-stated.
     */
    function glassFloat(blur) {
      const radius = Math.min(blur, 16);
      return `  background-color: color-mix(in srgb, var(--dshbg-raw-l2) 58%, transparent) !important;
  border: 1px solid color-mix(in srgb, var(--dshbg-raw-label-0) 16%, transparent) !important;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    0 10px 30px -14px rgb(0 0 0 / 0.55) !important;
  -webkit-backdrop-filter: blur(${radius}px) saturate(160%) !important;
  backdrop-filter: blur(${radius}px) saturate(160%) !important;`;
    }

    /**
     * Floating cards that must stay opaque, whatever the glass switch says.
     *
     * The turn navigator's hover preview (the little marks down the right edge of the
     * transcript) paints `--dsw-alias-bg-layer-1`, and that token *is* in the remix list, so
     * the wallpaper's transparency reaches it too - it ends up at 28% over whatever paragraph
     * it is covering. A preview card is the one kind of surface where a translucent fill is
     * not a style choice but a bug: the body text behind it reads straight through, and then
     * neither the preview nor the paragraph is legible.
     *
     * Restoring the captured, un-remixed layer value is enough - the card keeps the host's
     * own radius and `--dsw-elevation-panel`, so it still reads as floating. Matched on the
     * response line rather than the bare `_preview` class, which several other modules also
     * use for things that are not popovers.
     */
    function popoverCss() {
      return `
${prefixed('html[data-dshbg-on]', ['[class*="_preview"]:has([class*="_previewResponse"])'])} {
  background: var(--dshbg-raw-l1) !important;
}
`;
    }

    /**
     * Glass inside the transcript - file cards and code blocks. Always on.
     *
     * These are content, not chrome: they sit in the middle of the work area on top of the
     * wallpaper, and a flat opaque block there reads as a hole punched in the artwork. So
     * they do not follow the composer switch - turning the message box back to solid is a
     * statement about the box, not about every code block in the transcript.
     *
     * Three shapes, three hooks, none of them a hashed class guess:
     *
     * - Code blocks expose `[data-code-block-banner]`. Their wrapper class is
     *   `_block_<hash>_<line>` and the banner lives two levels down
     *   (`_bannerWrap` > `_banner[data-code-block-banner]`), so the wrapper is found with
     *   `[class*="_block_"]:has([data-code-block-banner])` - the `_block_` prefix survives a
     *   rebuild, the hash does not. Note the host also puts a plain `md-code-block` class on
     *   that same div, which is the one non-hashed hook in the whole transcript, but it only
     *   carries a margin, so the hashed prefix is still what has to be matched.
     *
     *   Three things paint the block's colour, and clearing two of them is what left the
     *   header bar solid: `_block` paints `var(--dsl-code-block-background)`, `pre` paints
     *   the same variable (with `!important` for shiki), and `_banner` paints
     *   `var(--dsl-code-block-banner-background-color)` - a *different* token that an
     *   earlier version never touched, because it only cleared `_bannerWrap`. Clearing the
     *   two custom properties on the wrapper handles all three at once, since both are
     *   inherited and every one of those rules reads them through `var()`. The explicit
     *   transparent rules stay as a belt-and-braces for the wrapper, which paints the
     *   global `--dsw-alias-bg-base` instead.
     * - Attachment chips are `cJsG2q_fileCard` - hash first, then the local name, so
     *   `[class*="_fileCard"]` is the stable half.
     * - Deliverable cards are `flL80G_file`, and they paint `var(--deliverable-fill)` - a
     *   *static neutral*, not one of the semantic tokens, which is why the token remix
     *   never reached them. The card also carries `data-presented-file`, which is the
     *   primary hook; `_file` alone would also catch the 24px composer chip and the
     *   changed-files row, so the class fallback requires the card's own `_fileBody` child.
     *   Both halves of that fallback are local names, so a rebuild does not move them.
     * - Inline code is `._markdown_<hash>_<line> :not(pre)>code`, painting
     *   `--dsw-alias-markdown-inline-code`. `_markdown_` is the stable half - note the
     *   trailing underscore, which keeps it away from `_markdownPreview`. The `:not(pre)`
     *   half is the host's own guard: it is what separates inline code from block code,
     *   and reproducing it means a block-level `pre` is never turned into a chip.
     */
    function transcriptGlassCss(settings) {
      const blur = clamp(settings.glassBlur, 0, 40);
      const block = `[class*="_block_"]:has([data-code-block-banner])`;
      const inlineCode = `[class*="_markdown_"] :not(pre) > code`;
      // The user's own message. `_bubble` paints `--dsw-specific-bubble`, another token
      // that is not in the remix list, so it stays the theme's opaque grey no matter what
      // the wallpaper is doing. Scoped by the flow item's `data-chat-flow-kind="user"` so
      // the same local name in other modules (trajectory, terminal) is not touched.
      const bubble = '[data-chat-flow-kind="user"] [class*="_bubble"]';
      // Separate array entries, never one comma-joined string: `prefixed()` prefixes each
      // *item*, so a comma inside an item would leave its tail unprefixed.
      const deliverable = ['[data-presented-file]', `[class$="_file"]:has(> [class$="_fileBody"])`];
      return `
${prefixed('html[data-dshbg-on]', ['[class*="_fileCard"]', ...deliverable, block, bubble])} {
${glassPane(blur)}
}
${prefixed('html[data-dshbg-on]', [block])} {
  --dsl-code-block-background: transparent !important;
  --dsl-code-block-banner-background-color: transparent !important;
}
${prefixed('html[data-dshbg-on]', [
  `${block} [class*="_bannerWrap"]`,
  `${block} [class*="_banner"]`,
  `${block} pre`,
])} {
  background: transparent !important;
}
${prefixed('html[data-dshbg-on]', [inlineCode])} {
${glassChip(blur)}
}
`;
    }

    /** The message box, on its own switch. */
    function composerGlassCss(settings) {
      if (settings.composerStyle !== 'glass') return '';
      return `
${prefixed('html[data-dshbg-on]', ['[data-composer-card]'])} {
${glassPane(clamp(settings.glassBlur, 0, 40))}
}
`;
    }

    /**
     * The panel behind the sidebar's history list.
     *
     * Rows are 2px apart (`_flatList > * + *`), so giving *each* row its own fill turns the
     * list into a stack of pills with no hierarchy - every folder reads like every session,
     * and the one you have open is barely distinguishable from the rest. One panel behind
     * the whole list is what the host itself assumes, and what every app of this shape does
     * (VS Code, ChatGPT, Claude): a flat list on a surface, with only hover and selection
     * tinted. So the rows are left completely alone - the host's own `:hover` and
     * `._selected` rules are the feedback, and overriding them was what made the selection
     * disappear.
     *
     * The ring is an inset shadow rather than a border: `_list` carries negative margins to
     * park the scrollbar, and a 1px border on a `content-box` scroller shifts that gutter.
     *
     * The vertical padding is not decoration. `_list` clips its content to a rectangle, so a
     * row painted near the bottom would show its own square corner poking through the
     * panel's rounded one - and a hovered row is exactly when that is visible. 8px is past
     * the point where a 10px corner has any curvature left (at y=8 the arc is 0.2px in), so
     * no row can ever reach it.
     *
     * The host's `_fade` overlay (the 24px gradient at the bottom of the list) is left
     * alone on purpose. It fades into `--dsw-specific-sidebar-fill`, and in whole-window
     * scope that token is re-mixed too, so it is already a translucent wash rather than the
     * solid band it would be if the token had stayed opaque. Painting over it would only
     * trade a soft edge for a hard one.
     */
    function glassList(blur) {
      const radius = Math.min(blur, 14);
      return `  background-color: color-mix(in srgb, var(--dshbg-raw-l1) 48%, transparent) !important;
  border-radius: 10px !important;
  padding: 8px 0 !important;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 12%, transparent),
    inset 0 1px 0 0 rgb(255 255 255 / 0.06) !important;
  -webkit-backdrop-filter: blur(${radius}px) saturate(150%) !important;
  backdrop-filter: blur(${radius}px) saturate(150%) !important;`;
    }

    /**
     * Glass inside the sidebar - the new-session button, the history panel and the cost meter.
     *
     * Gated on whole-window scope, because in work-area scope the sidebar is deliberately
     * left exactly as the theme paints it. Frosting a button that sits on an opaque panel
     * buys nothing: there is no artwork behind it to refract, and it would be the one
     * touched element in a column that is supposed to stay untouched.
     *
     * The button paints `--dsw-alias-button-elevated-fill` and the meter card paints
     * `--dsw-alias-bg-layer-1`, neither of which is glass by itself, so both get the full
     * recipe rather than a token nudge.
     *
     * The button is matched with `[class$=...]`, not `[class*=...]`: its children are
     * `_newSessionContent`, `_newSessionLabel`, `_newSessionLabelMask` and
     * `_newSessionShortcut`, every one of which contains `_newSession` as a substring and
     * would get a border and a drop shadow of its own.
     */
    function sidebarGlassCss(settings) {
      if (!settings.fullWindow) return '';
      const blur = clamp(settings.glassBlur, 0, 40);
      return `
${prefixed('html[data-dshbg-on]', ['[class$="_newSession"]', '.cm-footer-stack.summary:not(.rail)'])} {
${glassPane(blur)}
}
${prefixed('html[data-dshbg-on]', ['[class*="_treeBody"]'])} {
${glassList(blur)}
}
`;
    }

    /**
     * Glass on the composer's status row, the session-header chips, and the cost entries.
     *
     * The row is `[data-composer-dock]`, the host's `InputBar` dock. It carries the
     * `conversation.composer.dock` slot plus the context meter, and it paints no background
     * of its own - which is why the transcript scrolls straight through it and the row reads
     * as loose text sitting on the window edge rather than as a status bar.
     *
     * The header chips all live in one slot. `_headerActions` renders nothing but
     * `renderSlot("conversation.session.header.actions")`, so "every button in that slot" is
     * exactly "the chips next to the title" - 智能体团队, 标准模式, 4 个子智能体, and the cost
     * entry. All of them are `<button>`s the host draws with `background: 0 0; border: 0`,
     * i.e. bare text; frosting them is what turns that strip into one row of panes.
     *
     * The two `费用明细` entries are the cost meter's own `.cm-btn`s, one in that header slot
     * and one in this dock. They paint `--dsw-alias-button-elevated-fill`, which is not in
     * `SURFACE_TOKENS`, and in the dark theme that token resolves to the static `#43454a`. A
     * static neutral is invisible to a remix that only rewrites tokens, so these stayed black
     * pills while everything around them went frosted.
     *
     * Gated on the finish switch with the composer, not always on: the status row is composer
     * chrome sitting directly under the message box, and the header row has to match it, so
     * "solid" has to mean solid here too.
     *
     * The `.cm-btn`s keep their host border width (`1px`) - only the colour moves. The other
     * chips have no border at all, so they get the chip's `.5px` hairline; a full pixel on
     * both sides would visibly fatten a 28px-tall control.
     *
     * `:not([class*="_trigger"])` keeps the popover triggers bare. 智能体团队 and 4 个子智能体
     * are `<button class="..._trigger">` / `<button class="..._switcherTrigger">`, and a
     * permanent pill around a dropdown opener reads as a pressed button that never unpresses -
     * the popover that opens is where the glass belongs. 标准模式 is a filled chip in the
     * host's own design (`--dsw-alias-state-business-tertiary`), so it stays filled here too.
     */
    function statusGlassCss(settings) {
      if (settings.composerStyle !== 'glass') return '';
      const blur = clamp(settings.glassBlur, 0, 40);
      const dock = '[data-composer-dock]';
      const headerSlot = '[data-slot="conversation.session.header.actions"]';
      // The jump-to-bottom disc. `_toBottomSlot` is the zero-height sticky wrapper the host
      // puts around it, and it ends in `Slot`, so `[class$=...]` would already skip it - the
      // `:not()` keeps that true even if a second class is ever appended to either one.
      const toBottom = '[class*="_toBottom"]:not([class*="_toBottomSlot"])';
      return `
${prefixed('html[data-dshbg-on]', [dock])} {
  box-sizing: border-box !important;
  padding: 3px 8px !important;
  border-radius: 12px !important;
${glassPane(blur)}
}
${prefixed('html[data-dshbg-on]', [`${headerSlot} button:not([class*="_trigger"])`])} {
${glassChip(blur)}
}
${prefixed('html[data-dshbg-on]', [`${dock} .cm-btn`])} {
${glassChip(blur, '1px')}
}
${prefixed('html[data-dshbg-on]', [toBottom])} {
${glassFloat(blur)}
}
${prefixed('html[data-dshbg-on]', [`${toBottom}:hover`])} {
  background-color: color-mix(in srgb, var(--dshbg-raw-l2) 76%, transparent) !important;
}
`;
    }

    /**
     * Glass inside the team popover.
     *
     * The panel itself is already frosted - the host paints it with `--dsw-specific-menu`
     * plus `--dsw-menu-backdrop-filter` on a `::before` - and it matches the subagent panel
     * exactly. What did not match was the contents: the member cards paint
     * `--dsw-alias-bg-layer-2`, the theme's own opaque layer, so inside a see-through panel
     * they read as dark blocks.
     *
     * The subagent panel is the reference the user pointed at: its rows are completely
     * transparent, with a hover tint and nothing else. So the member card keeps no fill at
     * all. An earlier version gave it the chip recipe and it still looked wrong - the chip's
     * fill is `color-mix(--dshbg-raw-base 45%)`, and `--dshbg-raw-base` is derived from the
     * wallpaper's tone, so over a dark wallpaper the "chip" came out as a dark navy block.
     * No fill has no such failure mode.
     *
     * `[data-team-panel]`, not the header slot: the panel is rendered through
     * `createPortal` into `document.body`, so it is **not** a descendant of
     * `conversation.session.header.actions` - a slot-scoped selector silently matches
     * nothing. The host puts `data-team-panel` on the panel root precisely as a hook, and
     * unlike a hashed class it survives rebuilds.
     *
     * Task cards keep a light tint (the panel re-mixes `--dsw-alias-bg-layer-2` for
     * everything inside it) because they are blocks of prose, not rows - but they lose the
     * opacity that made them black holes.
     *
     * `button[class*="_member"]` and not `[class*="_member"]`: the card's children are
     * `_memberName`, `_memberNameText`, `_memberText`, `_memberDot` and `_memberModel`, and
     * the card for the current session also carries `_memberCurrent` - so neither `$=` nor a
     * bare `*=` picks out the card alone. Only the card itself is a button, which also keeps
     * the workflow-run panel's `_memberButton` out of reach.
     */
    function menuGlassCss(settings) {
      if (settings.composerStyle !== 'glass') return '';
      const teamPanel = '[data-team-panel]';
      const memberCard = `${teamPanel} button[class*="_member"]`;
      return `
${prefixed('html[data-dshbg-on]', [teamPanel])} {
  --dsw-alias-bg-layer-2: color-mix(in srgb, var(--dshbg-raw-l2) 62%, transparent) !important;
}
${prefixed('html[data-dshbg-on]', [memberCard])} {
  background-color: transparent !important;
  box-shadow: none !important;
}
${prefixed('html[data-dshbg-on]', [`${memberCard}:hover`, `${memberCard}:focus-visible`])} {
  background-color: color-mix(in srgb, var(--dshbg-raw-label-0) 9%, transparent) !important;
}
${prefixed('html[data-dshbg-on]', [`${memberCard}[class*="_memberCurrent"]`])} {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent) !important;
}
`;
    }

    /**
     * One breadcrumb, whichever element the host used for it.
     *
     * The current title is a `<span>`, its ancestors are `<button>`s - both carry the same
     * `_crumb` local class. `_crumbSeg`, `_crumbSep` and `_crumbs` contain that substring
     * too, so they are excluded by name rather than by position: the nav and its two
     * helpers are the ones that must not be treated as text to scroll.
     */
    const CRUMB = ':is(span, button)[class*="_crumb"]:not([class*="_crumbSeg"]):not([class*="_crumbSep"])';
    const CRUMB_HOST = '[class*="_crumb"]';

    /**
     * Let an over-long session title scroll instead of ending in an ellipsis.
     *
     * The title is a breadcrumb capped at `max-width: 220px` with `text-overflow: ellipsis`,
     * so a long session name is unreadable past the cap. CSS alone cannot fix that: a
     * marquee needs the overflow distance, and no length unit expresses "however much is
     * hidden".
     *
     * `text-indent` is the lever rather than `transform`, because the animation has to move
     * the text *inside* the element. A transform would drag the whole box - its hover fill
     * and its hit area - over the chips next to it.
     *
     * The clip is the one rule that has to live in the stylesheet: while the text is shifted
     * the ellipsis would otherwise stay pinned to the right edge, reading as "…" in the
     * middle of a word. `installTitleMarquee` measures and drives the animation.
     */
    /**
     * The gap the marquee puts between the title and its own repeat.
     *
     * Shared by the stylesheet and the animation: the repeat is a `::after` whose content
     * comes from `attr()`, so the distance it occupies has to be known by both sides. The
     * animation travels exactly `text width + this`, which is what makes the loop land on a
     * frame identical to the one it started from.
     */
    const MARQUEE_GAP = 32;

    /**
     * Speed the title travels at, in pixels per second. Slow enough to read, fast enough
     * that a short overflow still registers as movement.
     */
    const MARQUEE_SPEED = 45;

    function titleCss() {
      return `
${prefixed('html[data-dshbg-on]', [CRUMB])} {
  text-overflow: clip !important;
}
${prefixed('html[data-dshbg-on]', [`${CRUMB}[data-dshbg-mq]`])}::after {
  content: attr(data-dshbg-mq);
  margin-left: ${MARQUEE_GAP}px;
}
@keyframes dshbg-marquee {
  from { text-indent: 0px; }
  to { text-indent: var(--dshbg-mq-loop, 0px); }
}
${prefixed('html[data-dshbg-on]', [`${CRUMB}[data-dshbg-mq]`])} {
  animation: dshbg-marquee var(--dshbg-mq-dur, 6000ms) linear infinite;
}
`;
    }

    /**
     * Window chrome.
     *
     * The layout paints the drag strip as a `::before` over the frame's top padding, filled
     * with the sidebar colour. That strip is window chrome, not work area, so in work-area
     * scope it is left exactly as the layout paints it: one solid slice of the sidebar fill
     * across the full width.
     *
     * It used to be cleared and replaced with a gradient that ended at
     * `--dsh-windows-sidebar-width`, so the wallpaper continued above the work area while
     * the sidebar kept its own fill. That only holds while the sidebar is open. The layout
     * publishes the sidebar *track* width, and the track collapses to `0px` the moment the
     * sidebar closes - so the gradient's stop landed at zero and the entire strip turned
     * back into the full-width band of wallpaper it was introduced to remove. Closing the
     * sidebar reproduced the original complaint exactly.
     *
     * The band was already wrong in a second, quieter way: over a page that forces itself
     * opaque - the settings page does - a wallpaper strip sits directly on top of a dark
     * sheet, so it reads as a bright bar even with the sidebar open.
     *
     * Whole-window scope is the one case where the strip has to clear: there the chrome is
     * glass like everything else, and the wallpaper is meant to run behind the whole window.
     *
     * Both markers live on <html>, so they share one compound selector; a descendant
     * combinator between them never matches.
     */
    function chromeCss(settings) {
      const strip = settings.fullWindow ? 'transparent' : 'var(--dshbg-raw-sidebar)';
      return `
html[data-dshbg-on][data-windows-titlebar] ${frameSelector()}::before { background: ${strip} !important; }
html[data-dshbg-on][data-windows-titlebar] ${frameSelector()} { --dsh-windows-content-radius: 0px; }
`;
    }

    /**
     * Windows caption buttons (minimise / maximise / close).
     *
     * These are not DOM buttons. Electron draws them natively in a title-bar overlay, and
     * the overlay's own fill is opaque, so no rule aimed at the frame can reach it - which
     * is why they stay a solid block while everything around them turns to glass.
     *
     * The preload does expose one lever. It appends a hidden probe to `<body>`:
     *
     *   span[style="...;background-color:var(--dsw-specific-sidebar-fill);
     *                    color:var(--dsw-alias-label-primary)"]
     *
     * then reads that probe's *computed* background and text colour and sends them to the
     * main process over `dsh-desktop:windows-appearance`, which forwards them to
     * `setTitleBarOverlay`. A MutationObserver watches `<head>` childList/characterData,
     * so inserting this stylesheet is itself what triggers the re-read - no IPC access
     * needed, and disabling the plugin puts the theme colour straight back.
     *
     * The probe resolves its inline `var()` on `<body>`, one level *above* the frame where
     * the tokens are re-mixed. That is the whole bug: it kept reading the untouched,
     * opaque sidebar fill. Overriding the probe itself is narrower than re-declaring the
     * token on `<body>`, which would drag the sidebar along and make the `--dshbg-raw-*`
     * capture on that same element self-referential.
     *
     * Symbols are coloured from whatever the overlay ends up sitting on, which follows the
     * scope: whole-window scope puts them straight on the artwork, so they take the
     * wallpaper's measured tone; work-area scope keeps the strip solid, so they take the
     * theme's own label colour. Reusing the tone palette there would pick a colour chosen
     * for the wallpaper and could land dark-on-dark.
     */
    function captionCss(settings, tone) {
      const symbol = settings.fullWindow
        ? FONT_PALETTES[tone].primary
        : 'var(--dshbg-raw-label-0)';
      return `
html[data-dshbg-on] body > span[style*="--dsw-specific-sidebar-fill"] {
  background-color: transparent !important;
  color: ${symbol} !important;
}
`;
    }

    /**
     * In work-area scope the bottom status bar spans the full grid width, so its
     * translucency would leak the wallpaper underneath the sidebar. Keep it on the
     * theme's own base colour instead. In whole-window scope it is glass like the rest.
     */
    function bottomRowCss(settings) {
      if (settings.fullWindow) return '';
      return `
html[data-dshbg-on] ${bottomRowSelector()} { background-color: var(--dshbg-raw-base) !important; }
`;
    }

    function fontPalette(settings, tone) {
      if (settings.font === 'theme') return null;
      if (settings.font === 'auto') return FONT_PALETTES[tone];
      if (settings.font === 'custom') {
        const color = settings.fontColor;
        return {
          primary: color,
          secondary: `color-mix(in srgb, ${color} 80%, transparent)`,
          tertiary: `color-mix(in srgb, ${color} 64%, transparent)`,
          caption: `color-mix(in srgb, ${color} 54%, transparent)`,
          dimmed: `color-mix(in srgb, ${color} 70%, transparent)`,
          primaryDimmed: `color-mix(in srgb, ${color} 86%, transparent)`,
        };
      }
      return FONT_PALETTES[settings.font] || null;
    }

    function fontCss(settings, tone) {
      const palette = fontPalette(settings, tone);
      if (palette === null) return '';
      const scope = settings.fullWindow ? [frameSelector()] : workAreaColumns();
      return `
${prefixed('html[data-dshbg-on]', scope)} {
  color: ${palette.primary};
  --dsw-alias-label-primary: ${palette.primary};
  --dsw-alias-label-secondary: ${palette.secondary};
  --dsw-alias-label-tertiary: ${palette.tertiary};
  --dsw-alias-label-caption: ${palette.caption};
  --dsw-alias-label-dimmed: ${palette.dimmed};
  --dsw-alias-label-primary-dimmed: ${palette.primaryDimmed};
}
`;
    }

    /**
     * The settings page stays opaque while it is mounted.
     *
     * `data-dshbg-config` is set by the config component itself, so the stylesheet is
     * told rather than guessing from DOM shape. The fill goes on the *columns*, not on
     * a centred block: the page wrapper centres a 960px column inside a glass track, so
     * filling only the block would leave a bright wallpaper margin down each side.
     *
     * Restoring the label tokens matters because the auto palette was chosen for the
     * wallpaper; dark text on a dark base would be unreadable. They land on the same
     * element `fontCss` writes to, hence both `!important` and the extra attribute
     * selector to outrank it.
     */
    function configPageCss(settings) {
      const restores = LABEL_TOKENS.map(
        (token, index) => `  ${token}: var(--dshbg-raw-label-${index}) !important;`,
      ).join('\n');
      // The page has to turn opaque in exactly the area the wallpaper covers. In work-area
      // scope that is columns two and three, and the sidebar keeps its own fill; in
      // whole-window scope the sidebar is glass too, so leaving it out would put a
      // see-through strip beside a solid page - the same seam, rotated ninety degrees.
      const scope = settings.fullWindow ? [frameSelector()] : workAreaColumns();
      return `
${prefixed('html[data-dshbg-on][data-dshbg-config]', scope)} {
  background-color: var(--dshbg-raw-base) !important;
  background-image: none !important;
  color: var(--dshbg-raw-label-0) !important;
${restores}
}
`;
    }

    /**
     * Compatibility shim for `dsh-cost-meter` (1.9.x).
     *
     * Its panels paint `background: rgb(from var(--dsw-alias-bg-layer-2, ...) r g b / 1)`.
     * The trailing `/ 1` re-imposes full opacity, so any transparency put into the token
     * is discarded before it reaches the screen and the ledger stays a flat block.
     * Retargeting the classes is the only thing that survives that. If the plugin is not
     * installed the selectors simply match nothing.
     *
     * Dialogs get a near-opaque fill on top: a statistics modal at panel opacity puts
     * the wallpaper straight through the numbers.
     *
     * The header entry is hidden outright. The plugin registers the same `费用明细` button
     * twice - once in `conversation.session.header.actions`, once in
     * `conversation.composer.dock` - and only the dock one is wanted. Its own config key
     * (`hideSessionCostHeader`) does the same thing, but that lives in the plugin's ledger,
     * which it rewrites on every usage tick; a hand-edited value would be overwritten before
     * the next launch. Hiding it here is scoped to the header slot, so the dock entry and
     * the statistics dialog are untouched.
     */
    const CM_PANELS = ['.cm-section', '.cm-footer-stack.simple', '.cm-simple-summary'];
    const CM_DIALOGS = ['.cm-stat-dialog', '.cm-qguide', '.cm-peak-alert'];
    const CM_HEADER_ENTRY = '[data-slot="conversation.session.header.actions"] .cm-btn';

    function costMeterCss(settings) {
      const alpha = clamp(settings.surface, 0, 100);
      const dialogFill = Math.max(90, Math.min(97, alpha + 38));
      const cardFill = Math.max(88, Math.min(96, alpha + 30));
      return `
${prefixed('html[data-dshbg-on] body', CM_PANELS)} {
  background: color-mix(in srgb, var(--dshbg-raw-l2) ${alpha}%, transparent) !important;
}
${prefixed('html[data-dshbg-on] body', CM_DIALOGS)} {
  background: color-mix(in srgb, var(--dshbg-raw-l2) ${dialogFill}%, transparent) !important;
  --dsw-alias-bg-layer-1: color-mix(in srgb, var(--dshbg-raw-l1) ${cardFill}%, transparent) !important;
  --dsw-alias-bg-layer-2: color-mix(in srgb, var(--dshbg-raw-l2) ${cardFill}%, transparent) !important;
}
html[data-dshbg-on] .cm-stat-dialog::backdrop { background: rgb(0 0 0 / 58%); }
${prefixed('html[data-dshbg-on]', [CM_HEADER_ENTRY])} {
  display: none !important;
}
`;
    }

    function buildCss(settings, activeImage, tone) {
      const value = backgroundValue(settings, activeImage);
      if (value === null) return '';
      return [
        wallpaperCss(settings, value),
        tokenCss(settings),
        chatSurfaceCss(settings),
        composerCss(settings),
        chromeCss(settings),
        captionCss(settings, tone),
        bottomRowCss(settings),
        configPageCss(settings),
        fontCss(settings, tone),
        costMeterCss(settings),
        titleCss(),
        // Last, so the frosted panes are not re-painted by anything above.
        transcriptGlassCss(settings),
        // After every glass rule: this one puts transparency *back* to opaque.
        popoverCss(),
        composerGlassCss(settings),
        sidebarGlassCss(settings),
        statusGlassCss(settings),
        menuGlassCss(settings),
      ].join('');
    }

    // ------------------------------------------------------------------- install

    /**
     * Drives the session-title marquee.
     *
     * Pure CSS cannot do this: the distance to scroll is "however much is hidden", and no
     * length unit expresses that. So the distance is measured here and handed to a Web
     * Animation.
     *
     * Measurement uses a `Range` over the title's contents instead of `scrollWidth`. The
     * range reports the text's own width - the thing that actually has to travel - and it
     * stays correct while an animation is running. `scrollWidth` is read off the content
     * edge that `text-indent` is moving, so a live animation makes every re-measure read
     * its own output.
     *
     * The box is pinned with `min-width` while the animation runs. An inline-block is
     * shrink-to-fit, and `text-indent` contributes to the first line's max-content width,
     * so pulling the text left also narrows the box - which re-fires the ResizeObserver and
     * restarts the very animation that caused it. Pinning removes that feedback path. The
     * pin is cleared before every measure so a real resize still lands.
     *
     * Travel is one-directional and continuous: the title slides left at a constant speed
     * and the loop point lands on a frame identical to the one it started from. Two pieces
     * make that seamless. A `::after` repeats the text (its content comes from the
     * `data-dshbg-mq` attribute, so no DOM surgery on a React-owned node), and the animation
     * travels exactly `text width + MARQUEE_GAP` - the distance from "first copy starts at
     * the left edge" to "second copy starts at the left edge". Anything shorter shows a
     * blank box for part of every cycle; anything longer stutters at the seam.
     *
     * The distance was previously driven by the *overflow* and the motion was a there-and-back
     * pass on a fixed formula, "7s + 60ms/px". A title 22px too long got the same 8s pass as
     * one 200px too long: 2.6px/s, which reads as a title that does not move at all. Speed is
     * now a constant, so the overflow only decides whether it scrolls, not how long it takes.
     *
     * Re-measuring is driven by the title's own signals - a ResizeObserver on the crumbs nav
     * plus a MutationObserver filtered to the crumbs - not by a global observer. The
     * transcript mutates on every streamed token, and a global observer would restart the
     * marquee dozens of times a second. A few timed re-syncs after boot cover the case where
     * the header has not been laid out yet when the plugin starts.
     *
     * The motion itself is a **CSS animation**, not a Web Animation. That is deliberate: a
     * WAAPI animation is a JS-owned object, so anything that re-runs `sync()` can cancel or
     * replace it - and the host re-renders the header, which detaches and re-attaches the
     * title and silently kills whatever animation was attached to it. Declarative CSS is
     * re-applied by the style engine whenever the element comes back, so the scroll survives
     * every re-render. JS only writes three things: the `data-dshbg-mq` attribute that turns
     * the animation on, and the `--dshbg-mq-loop` / `--dshbg-mq-dur` custom properties that
     * set its distance and duration. Those are written only when they actually change,
     * because re-writing a custom property restarts the animation from zero.
     *
     * Everything is dropped when the wallpaper is off, because the matching
     * `text-overflow: clip` lives in the activation-scoped stylesheet. Left running without
     * it, a scrolling title would still pin its ellipsis to the right edge.
     */
    const MARQUEE_PROBE = 'dsh.custom-background.marquee.probe';
    const MARQUEE_TRACE = `${MARQUEE_PROBE}.trace`;
    // Two full cycles at 200ms. One cycle is not enough: the reported fault started at the
    // first wrap. 200ms still resolves a wrap (the loop is ~5.9s) while halving how much
    // this writes into LevelDB on every launch.
    const MARQUEE_TRACE_LIMIT = 60;

    /**
     * TEMPORARY diagnostics, module scope on purpose.
     *
     * The plugin is re-applied often enough that a per-install buffer is thrown away before
     * it fills, which is exactly why the first version of this trace never wrote anything.
     * Sharing the state here means a re-install adds a row rather than starting over - and
     * the generation number in each row is how a re-install shows up in the data.
     */
    let marqueeGen = 0;
    let marqueeTrace = null;
    let marqueeTraceTimer = 0;
    let marqueeTraceTicks = 0;
    let sheetWrites = 0;
    let syncCalls = 0;

    function installTitleMarquee() {
      const gen = ++marqueeGen;
      // The marquee is an enhancement, not a load-bearing part of the plugin: if the host
      // ever runs this outside a full renderer there is nothing to observe, and the title
      // simply keeps its ellipsis.
      if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') {
        return { sync() {}, dispose() {} };
      }

      /** @type {WeakSet<Element>} */
      const observed = new WeakSet();
      let timer = 0;
      let disposed = false;
      let probe = '';

      /**
       * Take the marquee back off an element.
       *
       * With the motion living in CSS, "stopping" is just dropping the attribute and the two
       * custom properties it feeds - there is no animation object to cancel, which is the
       * whole point: nothing in JS can restart or interrupt the scroll.
       */
      const stop = (crumb) => {
        // The repeat only exists to feed the loop. Leaving it behind would draw the title
        // twice in a box that is no longer scrolling.
        crumb.removeAttribute('data-dshbg-mq');
        crumb.style.removeProperty('--dshbg-mq-loop');
        crumb.style.removeProperty('--dshbg-mq-dur');
        crumb.style.removeProperty('min-width');
      };

      /**
       * Full teardown, for when the wallpaper goes away.
       *
       * `max-width` is deliberately *not* part of `stop()`. The title is widened to the room
       * the header actually has, and that is what decides whether it scrolls at all - drop
       * the cap on "this one fits" and the host's 220px ceiling comes back, the title no
       * longer fits, the loop starts again, the cap is re-applied... a two-frame oscillation
       * between scrolling and not. Only the wallpaper turning off may put it back.
       */
      const reset = (crumb) => {
        stop(crumb);
        crumb.style.removeProperty('max-width');
      };

      /**
       * How much width the title is actually allowed to use.
       *
       * The host caps every crumb at `max-width: 220px` because it expects to ellipsize.
       * That cap is what made a 232px title scroll forever inside a header that was mostly
       * empty: the title was never allowed to grow into the room beside it, so `shift` was
       * always positive and the marquee always ran - even though the whole title would have
       * fitted with 12px to spare.
       *
       * The layout is `_titleCluster{flex:1}` holding `_headerLeading{flex:none}` (the
       * crumbs) and `_headerActions{flex:none}` (the chips). The cluster's width is the
       * track's, so subtracting the chips and the gaps from it gives the room the crumbs row
       * may occupy; whatever else shares that row - separators, a second segment - is not
       * the title's. Everything here is a read, and the numbers do not move when the cap
       * changes (the cluster is `flex:1`), so this cannot feed back into itself.
       */
      const roomFor = (crumb) => {
        const cluster = crumb.closest('[class*="_titleCluster"]');
        if (cluster === null) return 0;
        let taken = 0;
        for (const child of cluster.children) {
          if (!child.contains(crumb)) taken += child.getBoundingClientRect().width;
        }
        const clusterStyle = getComputedStyle(cluster);
        const gap = parseFloat(clusterStyle.columnGap) || 0;
        let room = cluster.clientWidth - taken - gap * Math.max(0, cluster.children.length - 1);
        const crumbs = crumb.closest('[class*="_crumbs"]');
        if (crumbs !== null) {
          const rowGap = parseFloat(getComputedStyle(crumbs).columnGap) || 0;
          let count = 0;
          for (const child of crumbs.children) {
            if (child.contains(crumb)) continue;
            room -= child.getBoundingClientRect().width;
            count += 1;
          }
          room -= rowGap * count;
        }
        return Math.max(0, Math.floor(room));
      };

      /** Text width, box width, and the distance the text has to travel. */
      const measure = (crumb) => {
        const style = getComputedStyle(crumb);
        const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const box = crumb.clientWidth;
        const inner = Math.max(0, box - padding);
        let text = 0;
        try {
          const range = document.createRange();
          range.selectNodeContents(crumb);
          text = range.getBoundingClientRect().width;
        } catch {
          text = 0;
        }
        // `scrollWidth` as a fallback only: it is wrong exactly when it matters most (while
        // the text is shifted), but it is better than nothing if Range is unavailable. With
        // the repeat attached the line is two copies plus the gap, so the fallback has to
        // undo that first - otherwise each pass measures its own repeat and the loop
        // distance grows on every sync.
        if (!(text > 0)) {
          const line = Math.max(0, crumb.scrollWidth - padding);
          text = crumb.hasAttribute('data-dshbg-mq') ? Math.max(0, (line - MARQUEE_GAP) / 2) : line;
        }
        // `min-width` is resolved against the content box unless the box is `border-box`,
        // and `clientWidth` always includes the padding. Pinning the raw `clientWidth` on a
        // content-box crumb widens it by one padding pair - the title box grows and pushes
        // the chips beside it.
        const pin = style.boxSizing === 'border-box' ? box : inner;
        return { box, inner, pin, text, shift: Math.round(text - inner) };
      };

      /**
       * Last measurement, in localStorage. The marquee is the one part of this plugin whose
       * failure is invisible in a screenshot - a title that does not scroll looks exactly
       * like a title that fits - so it leaves its numbers behind where they can be read back
       * off disk when the plugin is running inside a packaged app with no devtools.
       * Deduplicated on everything except the timestamp, so a steady state writes nothing.
       */
      const record = (crumb, metrics, note) => {
        try {
          const payload = {
            on: document.documentElement.hasAttribute('data-dshbg-on'),
            n: document.querySelectorAll(CRUMB).length,
            cls: String(crumb.className ?? '').slice(0, 48),
            box: metrics.box,
            inner: metrics.inner,
            text: Math.round(metrics.text),
            shift: metrics.shift,
            sw: crumb.scrollWidth,
            mq: crumb.hasAttribute('data-dshbg-mq') ? 1 : 0,
            note,
          };
          const signature = JSON.stringify(payload);
          if (signature === probe) return;
          probe = signature;
          window.localStorage.setItem(MARQUEE_PROBE, JSON.stringify({ ...payload, at: Date.now() }));
        } catch {
          // Diagnostics must never be able to break the marquee.
        }
      };

      /**
       * TEMPORARY: what the animation is actually doing, read from the animation object
       * rather than inferred from the box. `text-indent` alone cannot tell a scrolling title
       * from one that restarts every few frames, and `scrollWidth` turned out to be useless
       * here - it does not move with `text-indent` at all. `currentTime` on the running
       * animation is the only number that answers the question: a sawtooth means restarts,
       * a ramp means it is scrolling, and `-1` means no animation is attached at all.
       */
      const trace = () => {
        if (marqueeTraceTimer !== 0 || marqueeTraceTicks >= MARQUEE_TRACE_LIMIT) return;
        if (marqueeTrace === null) marqueeTrace = [];
        marqueeTraceTimer = setInterval(() => {
          const crumb = document.querySelector(CRUMB);
          let row;
          if (crumb === null) {
            row = [Math.round(performance.now()), gen, 'gone', sheetWrites, syncCalls];
          } else {
            const style = getComputedStyle(crumb);
            const running = typeof crumb.getAnimations === 'function' ? crumb.getAnimations() : [];
            const anim = running[0];
            // `currentIteration` is what separates a legitimate wrap from a restart: a wrap
            // steps it up by one, a restart drops `currentTime` back to zero and leaves the
            // iteration where it was. `startTime` is the second witness - it only moves when
            // the animation is thrown away and rebuilt.
            const timing = anim ? anim.effect.getComputedTiming() : null;
            row = [
              Math.round(performance.now()),
              gen,
              style.textIndent,
              anim ? anim.playState : 'none',
              anim ? Math.round(Number(anim.currentTime) || 0) : -1,
              timing ? timing.currentIteration : -1,
              anim && anim.startTime !== null ? Math.round(Number(anim.startTime)) : -1,
              crumb.clientWidth,
              crumb.hasAttribute('data-dshbg-mq') ? 1 : 0,
              crumb.style.getPropertyValue('--dshbg-mq-loop'),
              crumb.style.getPropertyValue('--dshbg-mq-dur'),
              crumb.getAttribute('data-dshbg-mq')?.length ?? -1,
              (crumb.textContent ?? '').length,
              sheetWrites,
              syncCalls,
            ];
          }
          marqueeTrace.push(row);
          if (marqueeTrace.length > MARQUEE_TRACE_LIMIT) marqueeTrace.shift();
          try {
            window.localStorage.setItem(MARQUEE_TRACE, JSON.stringify(marqueeTrace));
          } catch {
            // Same rule as `record`: diagnostics may never break the marquee.
          }
          if (++marqueeTraceTicks >= MARQUEE_TRACE_LIMIT) {
            clearInterval(marqueeTraceTimer);
            marqueeTraceTimer = 0;
          }
        }, 200);
      };

      const apply = (crumb) => {
        // Widen the title to the room the header has *before* measuring it, so `shift`
        // answers the question that matters: does the title still not fit once it is allowed
        // to use the space around it?
        const before = getComputedStyle(crumb);
        const pad = (parseFloat(before.paddingLeft) || 0) + (parseFloat(before.paddingRight) || 0);
        const room = roomFor(crumb);
        if (room > 0) {
          const cap = Math.floor(before.boxSizing === 'border-box' ? room : Math.max(0, room - pad));
          const value = `${cap}px`;
          if (crumb.style.getPropertyValue('max-width') !== value) {
            crumb.style.setProperty('max-width', value, 'important');
          }
        }
        const metrics = measure(crumb);
        if (metrics.shift < 2) {
          stop(crumb);
          record(crumb, metrics, 'fits');
          return;
        }
        // The repeat is what makes the loop seamless, and its text has to track the title:
        // a renamed session keeps the same crumb node, so the attribute is refreshed on
        // every pass rather than only when the distance changes.
        const text = crumb.textContent ?? '';
        if (crumb.getAttribute('data-dshbg-mq') !== text) crumb.setAttribute('data-dshbg-mq', text);
        // Unrounded: the seam is exact only if the distance equals the measured text width
        // plus the gap. Rounding to whole pixels leaves a sub-pixel jump on every loop.
        const loop = metrics.text + MARQUEE_GAP;
        const distance = `-${loop.toFixed(2)}px`;
        // Writing these unconditionally would restart the CSS animation on every sync, which
        // is the one thing a marquee cannot survive. Only touch them when they move.
        if (crumb.style.getPropertyValue('--dshbg-mq-loop') !== distance) {
          crumb.style.setProperty('--dshbg-mq-loop', distance);
          crumb.style.setProperty('--dshbg-mq-dur', `${Math.max(3000, Math.round((loop / MARQUEE_SPEED) * 1000))}ms`);
        }
        if (metrics.pin > 0) crumb.style.setProperty('min-width', `${metrics.pin}px`, 'important');
        record(crumb, metrics, 'scroll');
        trace();
      };

      const sync = () => {
        if (disposed) return;
        syncCalls += 1;
        const crumbs = document.querySelectorAll(CRUMB);
        if (!document.documentElement.hasAttribute('data-dshbg-on')) {
          for (const crumb of crumbs) reset(crumb);
          return;
        }
        for (const crumb of crumbs) {
          // Observe the crumbs nav, not the crumb: observing the crumb would make our own
          // animation a resize source.
          const host = crumb.parentElement;
          if (host !== null && !observed.has(host)) {
            observed.add(host);
            resize.observe(host);
          }
          // Clear the pin first so the measurement sees the layout's own width.
          crumb.style.removeProperty('min-width');
          apply(crumb);
        }
      };

      const schedule = () => {
        if (disposed || timer !== 0) return;
        timer = setTimeout(() => {
          timer = 0;
          sync();
        }, 160);
      };

      const resize = new ResizeObserver(schedule);

      // Only mutations that touch a crumb matter. The transcript streams into the same
      // document, so the filter is what keeps this from being a per-token callback.
      const mutations = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target;
          const element = target.nodeType === 1 ? target : target.parentElement;
          if (element !== null && element !== undefined && element.closest(CRUMB_HOST) !== null) {
            schedule();
            return;
          }
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && node.querySelector(CRUMB) !== null) {
              schedule();
              return;
            }
          }
        }
      });

      // `documentElement`, not `body`: this runs before the host has necessarily committed
      // anything, and the whole tree is inside it either way.
      mutations.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      sync();

      // The header can mount before it has a width - a session still settling, a tab being
      // restored. Those first measurements read zero and bail, so ask again a few times
      // instead of waiting for a resize that may never come.
      const retries = [400, 1200, 3000].map((delay) =>
        setTimeout(() => {
          if (!disposed) sync();
        }, delay),
      );

      return {
        sync,
        dispose() {
          disposed = true;
          if (timer !== 0) clearTimeout(timer);
          // The trace keeps its buffer across installs, so the timer is the only part that
          // belongs to this instance.
          if (marqueeTraceTimer !== 0) {
            clearInterval(marqueeTraceTimer);
            marqueeTraceTimer = 0;
          }
          for (const handle of retries) clearTimeout(handle);
          resize.disconnect();
          mutations.disconnect();
          for (const crumb of document.querySelectorAll(CRUMB)) reset(crumb);
        },
      };
    }

    function installStyles(ctx) {
      const stale = document.querySelector(`style[data-dshbg-css="${PACKAGE}"]`);
      if (stale !== null) stale.remove();

      const tag = document.createElement('style');
      tag.setAttribute('data-dshbg-css', PACKAGE);
      document.head.appendChild(tag);

      const marquee = installTitleMarquee();

      let disposed = false;
      let measureToken = 0;
      let lastCss = null;

      const paint = () => {
        if (disposed) return;
        const { settings, activeImage, luma } = state;
        const on = backgroundValue(settings, activeImage) !== null;
        const root = document.documentElement;
        if (on) root.setAttribute('data-dshbg-on', '');
        else root.removeAttribute('data-dshbg-on');
        // Replacing a `<style>` element's text replaces every rule in it, which restarts
        // every CSS animation the sheet defines - including the title marquee. `paint()` is
        // called on each store commit, so writing an identical sheet would reset the scroll
        // to the beginning for no reason.
        const next = on ? buildCss(settings, activeImage, toneOf(luma)) : '';
        if (next !== lastCss) {
          lastCss = next;
          sheetWrites += 1;
          tag.textContent = next;
        }
        // Turning the wallpaper off also drops the `text-overflow: clip` that the marquee
        // depends on, so the animations have to follow the stylesheet, not the setting.
        marquee.sync();
      };

      /**
       * The artwork's pixels arrive asynchronously, so the tone lands a frame after the
       * stylesheet. The token is versioned: scrubbing a slider queues several
       * measurements and only the newest may write. The tone itself is a pure function
       * of the measurement, so a commit can never drive another different commit.
       *
       * The measurement used to run only for the auto-contrast font, which made it free
       * for everyone else. It now has a second consumer - the Windows caption symbols are
       * coloured from the wallpaper's tone whatever the font setting is - so it has to run
       * whenever a wallpaper is up. One 16x9 sample per change is not worth a second code
       * path, and skipping it left the captions stuck on the light palette.
       */
      const refresh = () => {
        paint();
        const { settings, activeImage } = state;
        if (settings.mode === 'none') {
          if (state.luma !== null) commit({ luma: null });
          return;
        }
        const token = ++measureToken;
        measureLuma(settings, activeImage).then((luma) => {
          if (disposed || token !== measureToken) return;
          if (state.luma === luma) return;
          commit({ luma });
        });
      };

      const unsubscribe = subscribe(refresh);
      refresh();
      boot();

      try {
        ctx.effect(
          () => () => {
            disposed = true;
            unsubscribe();
            marquee.dispose();
            tag.remove();
            document.documentElement.removeAttribute('data-dshbg-on');
          },
          'custom-background: stylesheet',
        );
      } catch (failure) {
        console.error('[dsh-custom-background] effect registration failed:', failure);
      }
    }

    function readDiagnostics() {
      return {
        style: document.querySelector(`style[data-dshbg-css="${PACKAGE}"]`) !== null,
        active: document.documentElement.hasAttribute('data-dshbg-on'),
        frame: document.querySelector(frameSelector()) !== null,
        columns: document.querySelectorAll(workAreaColumns().join(',')).length,
      };
    }

    // ------------------------------------------------------------------------ ui

    function Switch(props) {
      const { checked, label, hint, onChange } = props;
      return h(
        'label',
        { className: 'dshbg-switch' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'dshbg-switch-track', 'data-on': String(checked === true) }),
        h(
          'span',
          { className: 'dshbg-switch-text' },
          h('span', { className: 'dshbg-switch-label' }, label),
          hint ? h('span', { className: 'dshbg-switch-hint' }, hint) : null,
        ),
      );
    }

    function Segmented(props) {
      return h(
        'div',
        { className: 'dshbg-seg' },
        ...props.options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'data-active': String(option.value === props.value),
              onClick: () => props.onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function Slider(props) {
      return h(
        'div',
        { className: 'dshbg-slider' },
        h(
          'div',
          { className: 'dshbg-slider-head' },
          h('span', { className: 'dshbg-label' }, props.label),
          h('span', { className: 'dshbg-value' }, `${props.value}${props.suffix || ''}`),
        ),
        h('input', {
          type: 'range',
          min: props.min,
          max: props.max,
          step: props.step,
          value: props.value,
          onChange: (event) => props.onChange(Number(event.target.value)),
        }),
      );
    }

    const PAGE_CSS = `
.dshbg { display: flex; flex-direction: column; gap: 18px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f1115); }
.dshbg-head { display: flex; flex-direction: column; gap: 3px; }
.dshbg-title { font-size: 14px; font-weight: 600; line-height: 20px; margin: 0; }
.dshbg-sub { font-size: 12px; line-height: 17px; margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); }
.dshbg-preview { position: relative; height: 136px; border-radius: 10px; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 12%)); background: var(--dsw-alias-bg-layer-2, #eef0f3); }
.dshbg-preview-art { position: absolute; inset: -28px; background-position: center; background-size: cover; background-repeat: no-repeat; }
.dshbg-preview-dim { position: absolute; inset: 0; }
.dshbg-preview-row { position: relative; height: 100%; display: flex; }
.dshbg-preview-side { flex: 0 0 34%; background: var(--dsw-specific-sidebar-fill, #eceef1); display: flex; align-items: center; padding: 0 12px; }
.dshbg-preview-main { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 5px; padding: 0 14px; }
.dshbg-preview-t1 { font-size: 13px; font-weight: 600; }
.dshbg-preview-t2 { font-size: 12px; opacity: 0.82; }
.dshbg-preview-tag { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.55; }
.dshbg-section { display: flex; flex-direction: column; gap: 8px; }
.dshbg-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary, #4b5563); }
.dshbg-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-caption, #8b9098); margin: 0; }
.dshbg-seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgb(0 0 0 / 4%)); }
.dshbg-seg button { flex: 1; border: 0; border-radius: 6px; padding: 6px 0; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary, #4b5563); transition: background 0.12s ease, color 0.12s ease; }
.dshbg-seg button:hover { color: var(--dsw-alias-label-primary, #0f1115); }
.dshbg-seg button[data-active="true"] { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; box-shadow: 0 1px 2px rgb(0 0 0 / 10%); }
.dshbg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.dshbg-tile { position: relative; display: block; box-sizing: border-box; aspect-ratio: 16 / 10; border-radius: 8px; overflow: hidden; padding: 0; cursor: pointer; border: 1.5px solid transparent; background: var(--dsw-alias-bg-layer-2, #eef0f3); background-size: cover; background-position: center; }
.dshbg-tile[data-active="true"] { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.dshbg-tile-x { position: absolute; top: 4px; right: 4px; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 9px; cursor: pointer; font-size: 12px; line-height: 1; color: #fff; background: rgb(0 0 0 / 55%); }
.dshbg-add { border: 1px dashed var(--dsw-alias-border-l2, rgb(0 0 0 / 18%)); border-radius: 8px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary, #4b5563); font-size: 12px; aspect-ratio: 16 / 10; }
.dshbg-add:hover { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dsw-alias-label-primary, #0f1115); }
.dshbg-switch { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.dshbg-switch input { position: absolute; opacity: 0; pointer-events: none; }
.dshbg-switch-track { position: relative; flex: none; width: 34px; height: 20px; margin-top: 1px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3, rgb(0 0 0 / 18%)); transition: background 0.15s ease; }
.dshbg-switch-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 28%); transition: transform 0.15s ease; }
.dshbg-switch-track[data-on="true"] { background: var(--dsw-alias-state-business-primary, #4176e6); }
.dshbg-switch-track[data-on="true"]::after { transform: translateX(14px); }
.dshbg-switch-text { display: flex; flex-direction: column; gap: 2px; }
.dshbg-switch-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary, #0f1115); }
.dshbg-switch-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-caption, #8b9098); }
.dshbg-slider { display: flex; flex-direction: column; gap: 6px; }
.dshbg-slider-head { display: flex; align-items: baseline; justify-content: space-between; }
.dshbg-value { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-caption, #8b9098); }
.dshbg-slider input { width: 100%; accent-color: var(--dsw-alias-state-business-primary, #4176e6); }
.dshbg-swatches { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dshbg-swatch { width: 30px; height: 26px; border-radius: 6px; border: 1.5px solid transparent; cursor: pointer; padding: 0; }
.dshbg-swatch[data-active="true"] { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.dshbg-color { display: flex; align-items: center; gap: 8px; }
.dshbg-color input { width: 34px; height: 26px; padding: 0; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 18%)); border-radius: 6px; background: transparent; cursor: pointer; }
.dshbg-code { font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-tertiary, #6b7280); }
.dshbg-tone { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-caption, #8b9098); }
.dshbg-tone i { width: 10px; height: 10px; border-radius: 5px; border: 1px solid rgb(0 0 0 / 18%); }
.dshbg-error { font-size: 11px; line-height: 16px; padding: 8px 10px; border-radius: 6px; background: rgb(224 80 60 / 12%); color: var(--dsw-alias-label-primary, #0f1115); }
.dshbg-foot { display: flex; align-items: center; gap: 12px; padding-top: 2px; border-top: 0.5px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 8%)); }
.dshbg-link { border: 0; background: transparent; padding: 0; cursor: pointer; font-size: 11px; color: var(--dsw-alias-state-business-primary, #4176e6); }
.dshbg-diag { font-size: 10px; color: var(--dsw-alias-label-caption, #8b9098); margin-left: auto; font-variant-numeric: tabular-nums; }
`;

    // -------------------------------------------------------------------- config

    function ConfigPage(props) {
      const view = props && props.view;
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const { settings, images, activeImage, luma } = snapshot;
      const lang = currentLang();
      const text = TEXT[lang];
      const tone = toneOf(luma);

      const [error, setError] = useState(null);
      const [diag, setDiag] = useState(readDiagnostics);
      const fileInput = useRef(null);

      useEffect(() => {
        boot();
      }, []);

      /**
       * Tell the stylesheet that the settings page is on screen. Only the full detail
       * view counts: the same component also renders as a summary row inside the plugin
       * list, and going opaque there would repaint a page the user did not open.
       */
      useEffect(() => {
        if (view !== 'page') return undefined;
        const root = document.documentElement;
        root.setAttribute('data-dshbg-config', '');
        return () => root.removeAttribute('data-dshbg-config');
      }, [view]);

      useEffect(() => {
        const timer = window.setTimeout(() => setDiag(readDiagnostics()), 80);
        return () => window.clearTimeout(timer);
      }, [snapshot]);

      const pickFile = useCallback((file) => {
        if (!file) return;
        setError(null);
        addImage(file).catch((failure) => {
          setError(failure && failure.message === 'too-large' ? text.tooLarge : text.readFail);
        });
      }, [text.readFail, text.tooLarge]);

      const palette = fontPalette(settings, tone);
      const previewColor = palette === null ? null : palette.primary;
      const previewValue = backgroundValue(settings, activeImage);
      const sections = [];

      sections.push(
        h(
          'div',
          { key: 'preview', className: 'dshbg-section' },
          h('div', { className: 'dshbg-label' }, text.preview),
          h(
            'div',
            { className: 'dshbg-preview' },
            h('div', {
              className: 'dshbg-preview-art',
              style: {
                backgroundImage: previewValue === null ? 'none' : previewValue,
                filter: `blur(${Math.round(settings.blur / 2)}px)`,
              },
            }),
            h('div', {
              className: 'dshbg-preview-dim',
              style: { backgroundColor: `rgba(0, 0, 0, ${(settings.dim / 100).toFixed(3)})` },
            }),
            h(
              'div',
              { className: 'dshbg-preview-row' },
              h(
                'div',
                {
                  className: 'dshbg-preview-side',
                  style: settings.fullWindow
                    ? {
                        background: 'transparent',
                        color: previewColor === null ? undefined : previewColor,
                      }
                    : undefined,
                },
                h('span', { className: 'dshbg-preview-t2' }, text.previewPanel),
              ),
              h(
                'div',
                {
                  className: 'dshbg-preview-main',
                  style: {
                    backgroundColor: `color-mix(in srgb, var(--dsw-alias-bg-base, #fff) ${settings.chatSurface}%, transparent)`,
                    color: previewColor === null ? undefined : previewColor,
                  },
                },
                h('span', { className: 'dshbg-preview-tag' }, text.preview),
                h('span', { className: 'dshbg-preview-t1' }, text.title),
                h('span', { className: 'dshbg-preview-t2' }, text.previewSample),
              ),
            ),
          ),
        ),
      );

      sections.push(
        h(
          'div',
          { key: 'type', className: 'dshbg-section' },
          h('div', { className: 'dshbg-label' }, text.type),
          h(Segmented, {
            value: settings.mode,
            options: [
              { value: 'none', label: text.modes.none },
              { value: 'image', label: text.modes.image },
              { value: 'gradient', label: text.modes.gradient },
              { value: 'color', label: text.modes.color },
            ],
            onChange: (value) => patchSettings({ mode: value }),
          }),
        ),
      );

      if (settings.mode === 'image') {
        const gallery = images === null ? [] : images;
        sections.push(
          h(
            'div',
            { key: 'gallery', className: 'dshbg-section' },
            h('div', { className: 'dshbg-label' }, text.gallery),
            h(
              'div',
              { className: 'dshbg-grid' },
              ...gallery.map((record) =>
                h(
                  'div',
                  {
                    key: record.id,
                    role: 'button',
                    tabIndex: 0,
                    className: 'dshbg-tile',
                    'data-active': String(record.id === settings.imageId),
                    style: { backgroundImage: `url("${record.dataUrl}")` },
                    onClick: () => patchSettings({ imageId: record.id }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        patchSettings({ imageId: record.id });
                      }
                    },
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshbg-tile-x',
                      'aria-label': text.remove,
                      title: text.remove,
                      onClick: (event) => {
                        event.stopPropagation();
                        removeImage(record.id).catch(() => setError(text.readFail));
                      },
                    },
                    '\u00d7',
                  ),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshbg-add',
                  onClick: () => fileInput.current && fileInput.current.click(),
                },
                text.add,
              ),
            ),
            gallery.length === 0 ? h('p', { className: 'dshbg-hint' }, text.empty) : null,
            h('p', { className: 'dshbg-hint' }, text.galleryHint),
          ),
        );
      }

      if (settings.mode === 'gradient') {
        sections.push(
          h(
            'div',
            { key: 'gradient', className: 'dshbg-section' },
            h('div', { className: 'dshbg-label' }, text.gradient),
            h(
              'div',
              { className: 'dshbg-grid' },
              ...GRADIENTS.map((preset, index) =>
                h('button', {
                  key: index,
                  type: 'button',
                  className: 'dshbg-tile',
                  'data-active': String(index === settings.gradient),
                  style: { backgroundImage: preset.css },
                  onClick: () => patchSettings({ gradient: index }),
                }),
              ),
            ),
          ),
        );
      }

      if (settings.mode === 'color') {
        sections.push(
          h(
            'div',
            { key: 'color', className: 'dshbg-section' },
            h('div', { className: 'dshbg-label' }, text.color),
            h(
              'div',
              { className: 'dshbg-swatches' },
              ...SWATCHES.map((swatch) =>
                h('button', {
                  key: swatch,
                  type: 'button',
                  className: 'dshbg-swatch',
                  'data-active': String(swatch.toLowerCase() === settings.color.toLowerCase()),
                  style: { backgroundColor: swatch },
                  onClick: () => patchSettings({ color: swatch }),
                }),
              ),
              h(
                'label',
                { className: 'dshbg-color' },
                h('input', {
                  type: 'color',
                  value: settings.color,
                  'aria-label': text.customColor,
                  onChange: (event) => patchSettings({ color: event.target.value }),
                }),
                h('span', { className: 'dshbg-code' }, settings.color.toUpperCase()),
              ),
            ),
          ),
        );
      }

      sections.push(
        h(
          'div',
          { key: 'scope', className: 'dshbg-section' },
          h('div', { className: 'dshbg-label' }, text.scope),
          h(Switch, {
            checked: settings.fullWindow,
            label: text.fullWindow,
            hint: text.fullWindowHint,
            onChange: (value) => patchSettings({ fullWindow: value }),
          }),
        ),
      );

      const toneSwatch =
        settings.font === 'auto'
          ? h(
              'span',
              { className: 'dshbg-tone' },
              h('i', { style: { background: FONT_PALETTES[tone].primary } }),
              luma === null ? '' : `${tone === 'dark' ? text.toneDark : text.toneLight} · ${Math.round(luma)}`,
            )
          : null;

      sections.push(
        h(
          'div',
          { key: 'font', className: 'dshbg-section' },
          h('div', { className: 'dshbg-label' }, text.font),
          h(Segmented, {
            value: settings.font,
            options: [
              { value: 'theme', label: text.fonts.theme },
              { value: 'auto', label: text.fonts.auto },
              { value: 'light', label: text.fonts.light },
              { value: 'dark', label: text.fonts.dark },
              { value: 'custom', label: text.fonts.custom },
            ],
            onChange: (value) => patchSettings({ font: value }),
          }),
          settings.font === 'custom'
            ? h(
                'div',
                { className: 'dshbg-color' },
                h('input', {
                  type: 'color',
                  value: settings.fontColor,
                  'aria-label': text.customFont,
                  onChange: (event) => patchSettings({ fontColor: event.target.value }),
                }),
                h('span', { className: 'dshbg-code' }, settings.fontColor.toUpperCase()),
              )
            : null,
          toneSwatch,
          h('p', { className: 'dshbg-hint' }, text.fontHint),
        ),
      );

      if (settings.mode !== 'none') {
        sections.push(
          h(
            'div',
            { key: 'sliders', className: 'dshbg-section', style: { gap: '12px' } },
            h(Slider, {
              label: text.blur,
              value: settings.blur,
              min: 0,
              max: 40,
              step: 1,
              suffix: 'px',
              onChange: (value) => patchSettings({ blur: value }),
            }),
            h(Slider, {
              label: text.dim,
              value: settings.dim,
              min: 0,
              max: 80,
              step: 1,
              suffix: '%',
              onChange: (value) => patchSettings({ dim: value }),
            }),
            h(Slider, {
              label: text.surface,
              value: settings.surface,
              min: 0,
              max: 100,
              step: 1,
              suffix: '%',
              onChange: (value) => patchSettings({ surface: value }),
            }),
            h('p', { className: 'dshbg-hint' }, text.surfaceHint),
            h(Slider, {
              label: text.chatSurface,
              value: settings.chatSurface,
              min: 0,
              max: 100,
              step: 1,
              suffix: '%',
              onChange: (value) => patchSettings({ chatSurface: value }),
            }),
            h('p', { className: 'dshbg-hint' }, text.chatSurfaceHint),
            settings.composerStyle === 'glass'
              ? h(Slider, {
                  label: text.glassBlur,
                  value: settings.glassBlur,
                  min: 0,
                  max: 40,
                  step: 1,
                  suffix: 'px',
                  onChange: (value) => patchSettings({ glassBlur: value }),
                })
              : h(Slider, {
                  label: text.composerSurface,
                  value: settings.composerSurface,
                  min: 0,
                  max: 100,
                  step: 1,
                  suffix: '%',
                  onChange: (value) => patchSettings({ composerSurface: value }),
                }),
            settings.composerStyle === 'glass'
              ? null
              : h('p', { className: 'dshbg-hint' }, text.composerSurfaceHint),
          ),
        );
      }

      sections.push(
        h(
          'div',
          { key: 'finish', className: 'dshbg-section' },
          h('div', { className: 'dshbg-label' }, text.glass),
          h(Segmented, {
            value: settings.composerStyle,
            options: [
              { value: 'solid', label: text.glassSolid },
              { value: 'glass', label: text.glassLiquid },
            ],
            onChange: (value) => patchSettings({ composerStyle: value }),
          }),
          h(
            'p',
            { className: 'dshbg-hint' },
            settings.composerStyle === 'glass' ? text.glassHint : text.glassHintSolid,
          ),
        ),
      );

      return h(
        'div',
        { className: 'dshbg' },
        h('style', { 'data-dshbg-page': 'config' }, PAGE_CSS),
        h(
          'input',
          {
            ref: fileInput,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            onChange: (event) => {
              const file = event.target.files && event.target.files[0];
              pickFile(file);
              event.target.value = '';
            },
          },
        ),
        h(
          'div',
          { className: 'dshbg-head' },
          h('h3', { className: 'dshbg-title' }, text.title),
          h('p', { className: 'dshbg-sub' }, text.subtitle),
        ),
        ...sections,
        error === null ? null : h('div', { className: 'dshbg-error' }, error),
        diag.frame && diag.columns > 0 ? null : h('div', { className: 'dshbg-error' }, text.broken),
        h(
          'div',
          { className: 'dshbg-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshbg-link',
              onClick: () => {
                setError(null);
                patchSettings({ ...DEFAULTS, imageId: settings.imageId });
              },
            },
            text.reset,
          ),
          h(
            'span',
            { className: 'dshbg-diag' },
            `${text.diagnostics} ${diag.style ? '\u2713' : '\u2717'} / ${diag.active ? '\u2713' : '\u2717'} / ${
              diag.frame ? '\u2713' : '\u2717'
            } / ${diag.columns}`,
          ),
        ),
      );
    }

    // --------------------------------------------------------------- registration

    return {
      inject: ['slots'],
      apply(ctx) {
        // The two halves are isolated: a failure in either must never take the other
        // down, and neither may escape `apply` and break the WebUI module load.
        try {
          installStyles(ctx);
        } catch (failure) {
          console.error('[dsh-custom-background] stylesheet install failed:', failure);
        }

        try {
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: PACKAGE, id: 'custom-background', order: 10 },
              ConfigPage,
            ),
          );
        } catch (failure) {
          console.error('[dsh-custom-background] config slot registration failed:', failure);
        }
      },
    };
  },
});
