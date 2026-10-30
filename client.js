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
    const SETTINGS_KEY = 'dsh.custom-background.settings.v4';
    const LEGACY_SETTINGS_KEY = 'dsh.custom-background.settings.v3';
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
      blur: 20,
      dim: 15,
      surface: 50,
      chatSurface: 0,
      composerSurface: 50,
      composerStyle: 'solid',
      glassBlur: 40,
      // The menu glass, baked in. These two were sliders ("scratch controls") while the
      // pair was being judged on a real wallpaper, because fill and blur trade against each
      // other: the host's 40px flattened the artwork into a wash, which forced the fill up
      // to 76% to keep the text readable, and 76% is what stopped it looking like glass.
      // Settled at 30 / 50. They stay in `settings` rather than becoming constants so that a
      // value already in storage keeps working and `parsePreset` keeps clamping it.
      menuFill: 30,
      menuBlur: 50,
      // The sidebar's own density when it is included in the scope. Measured separately
      // from the panel slider because that column has two paint layers (host column plus
      // its inner root) and therefore reads darker than the same alpha elsewhere.
      sidebarFill: 40,
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
        perSourceHint: '下面这些滑杆属于当前这张背景。换一张会自动换成它自己上次调好的样子，不会互相影响。',
        globalHint: '玻璃模糊、作用范围、字体是全局的，所有背景共用一套。',
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
        perSourceHint: 'The sliders below belong to the current background. Switching to another one brings back its own last values.',
        globalHint: 'Glass blur, scope and typeface are global - one set for every background.',
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

    // The two menu-glass numbers, with their bounds stated once. They are read at a dozen
    // call sites across the recipes; a bound written twelve times is a bound that drifts on
    // the twelfth edit. Every menu-derived surface goes through these two functions.
    const menuFillOf = (settings) => clamp(settings.menuFill, 20, 100);
    const menuBlurOf = (settings) => clamp(settings.menuBlur, 0, 320);
    const surfaceOf = (settings) => clamp(settings.surface, 0, 100);

    function currentLang() {
      const raw = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
      return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    // ---------------------------------------------------------------- persistence

    /** Which artwork is up. Changing one of these is what "switching background" means. */
    const POINTER_KEYS = ['mode', 'imageId', 'gradient', 'color'];

    /** How the artwork is presented. Every source keeps its own copy of these. */
    const PRESENTATION_KEYS = [
      'blur',
      'dim',
      'surface',
      'chatSurface',
      'composerSurface',
      'composerStyle',
      'menuFill',
      'sidebarFill',
    ];

    /**
     * The material, not the artwork.
     *
     * Glass blur is one number for the whole app on purpose: a dialog that fogs differently
     * depending on which picture sits behind it would read as a bug, not as a feature. Same
     * for the scope, the typeface and its colour - those describe the interface, and the
     * interface does not change when the wallpaper does.
     */
    const GLOBAL_KEYS = ['glassBlur', 'menuBlur', 'fullWindow', 'font', 'fontColor'];

    const DEFAULT_PRESET = (() => {
      const preset = {};
      for (const field of PRESENTATION_KEYS) preset[field] = DEFAULTS[field];
      return preset;
    })();

    /**
     * One key per artwork.
     *
     * Images and custom colours are keyed by their own identity, so `#1b2233` and `#0d1117`
     * are two sources with two sets of sliders; gradients are keyed by preset index. "Off"
     * is a source too - its sliders are worth remembering, otherwise turning the wallpaper
     * off and back on would cost the user their panel density.
     */
    function sourceKeyOf(settings) {
      if (settings.mode === 'image') return settings.imageId === null ? 'image:-' : `image:${settings.imageId}`;
      if (settings.mode === 'gradient') return `gradient:${clamp(settings.gradient, 0, GRADIENTS.length - 1)}`;
      if (settings.mode === 'color') return `color:${String(settings.color).toLowerCase()}`;
      return 'none';
    }

    /** One set of presentation values, with every field clamped and defaulted. */
    function parsePreset(value) {
      const source = value === null || typeof value !== 'object' ? {} : value;
      const pick = (field) => (source[field] === undefined ? DEFAULT_PRESET[field] : source[field]);
      return {
        blur: clamp(pick('blur'), 0, 40),
        dim: clamp(pick('dim'), 0, 80),
        surface: clamp(pick('surface'), 0, 100),
        chatSurface: clamp(pick('chatSurface'), 0, 100),
        composerSurface: clamp(pick('composerSurface'), 0, 100),
        composerStyle: pick('composerStyle') === 'glass' ? 'glass' : 'solid',
        menuFill: clamp(pick('menuFill'), 20, 100),
        sidebarFill: clamp(pick('sidebarFill'), 0, 100),
      };
    }

    /**
     * `raw` is the document that gets persisted: pointers, one preset per source, and the
     * global keys. It is *not* what the rest of the plugin reads - see `flatten`.
     */
    function readRaw() {
      const parse = (text) => {
        try {
          const value = text === null ? null : JSON.parse(text);
          return value !== null && typeof value === 'object' ? value : null;
        } catch {
          return null;
        }
      };
      const stored = parse(window.localStorage.getItem(SETTINGS_KEY));
      const legacy = parse(window.localStorage.getItem(LEGACY_SETTINGS_KEY));

      // A v3 file has a single flat set of sliders shared by every artwork. It becomes the
      // base every source falls back to, so an existing user does not watch every picture
      // except the current one snap back to the factory values on the first switch.
      const base = parsePreset(legacy);

      const presets = {};
      if (stored !== null && stored.presets !== null && typeof stored.presets === 'object') {
        for (const [key, value] of Object.entries(stored.presets)) presets[key] = parsePreset(value);
      }

      const from = stored === null ? (legacy === null ? {} : legacy) : stored;
      const modes = ['none', 'image', 'gradient', 'color'];
      const fonts = ['theme', 'auto', 'light', 'dark', 'custom'];
      return {
        mode: modes.includes(from.mode) ? from.mode : DEFAULTS.mode,
        imageId: typeof from.imageId === 'string' ? from.imageId : null,
        gradient: clamp(from.gradient === undefined ? DEFAULTS.gradient : from.gradient, 0, GRADIENTS.length - 1),
        color: /^#[0-9a-f]{6}$/i.test(String(from.color)) ? String(from.color) : DEFAULTS.color,
        base,
        presets,
        glassBlur: clamp(from.glassBlur === undefined ? DEFAULTS.glassBlur : from.glassBlur, 0, 40),
        menuBlur: clamp(from.menuBlur === undefined ? DEFAULTS.menuBlur : from.menuBlur, 0, 320),
        fullWindow: from.fullWindow === true,
        font: fonts.includes(from.font) ? from.font : DEFAULTS.font,
        fontColor: /^#[0-9a-f]{6}$/i.test(String(from.fontColor)) ? String(from.fontColor) : DEFAULTS.fontColor,
      };
    }

    /** The preset a source uses: its own, else the migrated base, else the factory values. */
    function presetOf(raw, key) {
      const own = raw.presets[key];
      if (own !== undefined) return own;
      return raw.base === undefined ? DEFAULT_PRESET : raw.base;
    }

    /**
     * The flat view every consumer reads - `settings.blur` and friends.
     *
     * It is recomputed from `raw` on every commit rather than stored beside it. A flat copy
     * that only some code paths update is precisely the bug `activeImage` had: the value
     * looked right until you switched, and "reload fixes it" was the fingerprint.
     */
    function flatten(raw) {
      const { presets, base, ...rest } = raw;
      return { ...rest, ...presetOf(raw, sourceKeyOf(raw)) };
    }

    function writeRaw(raw) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(raw));
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
      const panelMix = surfaceOf(settings) / 100;
      return base * dimFactor * (1 - panelMix) + PANEL_LUMA * panelMix;
    }

    /** Pure: the same luma always yields the same tone. No hysteresis, no feedback. */
    function toneOf(luma) {
      if (luma === null) return 'light';
      return luma > TONE_THRESHOLD ? 'dark' : 'light';
    }

    // -------------------------------------------------------------------- store

    /**
     * The artwork on screen is a *function* of the gallery and the selected id — never a
     * second copy of it.
     *
     * Keeping a stored `activeImage` next to `settings.imageId` is exactly how "clicking
     * another picture does nothing" happened: the gallery tile wrote the id, `paint()` read
     * the stale copy, and the only place that ever set both was `addImage()` — so the
     * wallpaper was frozen on the newest upload until a reload re-derived it in `boot()`.
     * Deriving it on every commit makes that class of drift impossible to reintroduce.
     */
    function activeImageOf(images, settings) {
      if (!Array.isArray(images)) return null;
      const record = images.find((item) => item.id === settings.imageId);
      return record === undefined ? null : record.dataUrl;
    }

    /** Both flat views are derived from `raw`; neither is stored next to it. */
    const derive = (next) => ({
      ...next,
      settings: flatten(next.raw),
      activeImage: activeImageOf(next.images, next.raw),
    });

    let state = derive({ raw: readRaw(), settings: null, activeImage: null, images: null, luma: null });
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

    /**
     * Fold a settings patch into the raw document.
     *
     * Pointers go first so that a patch which switches source *and* moves a slider in one
     * call lands the slider on the source being switched to. A presentation key never
     * touches a source other than the current one — that is the whole feature.
     *
     * `presets` is the one escape hatch: `addImage` uses it to hand a new picture the
     * look that is on screen, `removeImage` uses `null` to drop a picture's set.
     */
    function applySettingsPatch(raw, patch) {
      const next = { ...raw };
      for (const field of POINTER_KEYS) if (patch[field] !== undefined) next[field] = patch[field];
      if (patch.presets !== undefined) {
        next.presets = { ...next.presets };
        for (const [key, value] of Object.entries(patch.presets)) {
          if (value === null) delete next.presets[key];
          else next.presets[key] = { ...value };
        }
      }
      const key = sourceKeyOf(next);
      let preset = null;
      for (const field of PRESENTATION_KEYS) {
        if (patch[field] === undefined) continue;
        if (preset === null) preset = { ...presetOf(next, key) };
        preset[field] = patch[field];
      }
      if (preset !== null) next.presets = { ...next.presets, [key]: preset };
      for (const field of GLOBAL_KEYS) if (patch[field] !== undefined) next[field] = patch[field];
      return next;
    }

    /**
     * `settingsPatch` is optional and applied in the *same* commit as `patch`. Two separate
     * commits would paint twice: once with the new gallery and the old selection, once with
     * both — a visible flash of the wrong wallpaper.
     */
    function commit(patch, settingsPatch) {
      const raw = settingsPatch === undefined ? state.raw : applySettingsPatch(state.raw, settingsPatch);
      state = derive({ ...state, ...patch, raw });
      if (settingsPatch !== undefined) writeRaw(state.raw);
      emit();
    }

    function patchSettings(patch) {
      commit({}, patch);
    }

    let booted = false;
    function boot() {
      if (booted) return;
      booted = true;
      listImageRecords()
        .then((records) => {
          const images = Array.isArray(records) ? records : [];
          commit({ images });
        })
        .catch(() => commit({ images: [] }));
    }

    async function addImage(file) {
      const dataUrl = await ingestFile(file);
      const record = { id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dataUrl, addedAt: Date.now() };
      await putImageRecord(record);
      const images = (state.images === null ? [] : state.images).concat(record);
      // A new picture inherits the look that is on screen right now. Uploading is meant to
      // change the artwork, not to throw away the sliders the user just dialled in.
      const inherited = { ...presetOf(state.raw, sourceKeyOf(state.raw)) };
      commit(
        { images },
        { mode: 'image', imageId: record.id, presets: { [`image:${record.id}`]: inherited } },
      );
      return record;
    }

    /**
     * Removing the picture that is on screen must not turn the wallpaper off.
     *
     * It used to null `imageId` and force `mode: 'none'`, so deleting one tile blanked the
     * whole app even though the gallery still held other pictures. The selection now slides
     * to the tile that takes its place (or to the new last one, when the deleted tile was
     * last), which keeps the eye where it already was. Only an empty gallery — nothing left
     * to show — falls back to "no background".
     *
     * The deleted picture's preset goes with it, otherwise the store grows a set of sliders
     * for an id nothing can ever select again.
     */
    async function removeImage(id) {
      await deleteImageRecord(id);
      const before = state.images === null ? [] : state.images;
      const images = before.filter((record) => record.id !== id);
      const wasActive = state.raw.imageId === id;
      const settingsPatch = { presets: { [`image:${id}`]: null } };
      if (wasActive) {
        const index = before.findIndex((record) => record.id === id);
        const at = index < 0 ? images.length - 1 : Math.min(index, images.length - 1);
        const successor = images.length === 0 ? null : images[at];
        if (successor === null) {
          settingsPatch.imageId = null;
          if (state.raw.mode === 'image') settingsPatch.mode = 'none';
        } else {
          settingsPatch.imageId = successor.id;
        }
      }
      commit({ images }, settingsPatch);
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
     *
     * It also keeps `lift: 0`, unlike every other surface. Thickening the whole column
     * (tried in 2.16, `lift: 24`) makes the sidebar read as one flat slab and loses the
     * wallpaper entirely behind it; the history list carries its own block instead - see
     * `historyBlockCss`.
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
      // Added after auditing the host stylesheet for its most common background tokens.
      // Each of these used to paint an opaque surface that no other rule reached - which is
      // why they showed up as isolated black blocks over a wallpaper:
      //   markdown-code-block : the output body of a command/tool card AND markdown code
      //                         blocks - the "退出码 1" box in the transcript;
      //   bg-module-platform  : settings-style module cards across the app;
      //   settings-card-fill  : the preference cards inside those modules;
      //   specific-menu       : menu/popover fills that are not the material primitive;
      //   fill-l1 / fill-l2   : the generic "raised surface" pair used by panel chrome.
      { token: '--dsw-alias-markdown-code-block', raw: 'code', lift: 6 },
      { token: '--dsw-alias-bg-module-platform', raw: 'module', lift: 12 },
      { token: '--dsw-alias-settings-card-fill', raw: 'card', lift: 10 },
      { token: '--dsw-specific-menu', raw: 'menu', lift: 10 },
      { token: '--dsw-alias-fill-l1', raw: 'fill1', lift: 8 },
      { token: '--dsw-alias-fill-l2', raw: 'fill2', lift: 14 },
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

    /**
     * The wallpaper, one fixed layer behind everything.
     *
     * **The geometry is deliberately `vw`/`vh` and not `inset: -Npx`.** They look identical
     * - same box, same `cover` crop - but they do not react to the same things. `inset`
     * resolves against the *viewport*, so the moment a scrollbar appears or disappears the
     * box changes size by the scrollbar's width, and a full-screen `filter: blur(50px)` has
     * to be redone from scratch. `vw`/`vh` resolve against the *initial containing block*,
     * which includes the scrollbar gutter and therefore does not move when the scrollbar
     * does.
     *
     * That difference is the whole reason a streaming reply used to blank the transcript
     * column for a frame: content grew, something below started overflowing, a horizontal
     * scrollbar came and went, the wallpaper re-blurred, and the backdrop snapshot the
     * transcript's glass was waiting on was not ready in time. `will-change: filter` keeps
     * the blurred result cached across the repaints that remain.
     */
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
  top: -${bleed}px;
  left: -${bleed}px;
  width: calc(100vw + ${bleed * 2}px);
  height: calc(100vh + ${bleed * 2}px);
  z-index: -1;
  pointer-events: none;
  background-image: ${value};
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(${settings.blur}px);
  transform: translateZ(0);
  will-change: filter;
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

    /**
     * Capture on `body`, remix on `body > *`.
     *
     * The host declares its palette on `body` (light) and `body[data-ds-dark-theme]` (dark),
     * so the capture has to sit exactly there. The remix has to be one level below, or the
     * capture reads the value it just wrote.
     *
     * The remix used to sit on the frame, and that is why every **portaled** surface stayed
     * black: `#root` is not the whole document, and host dialogs (设置), the cost meter's
     * dialogs and third-party popovers are its *siblings* under `body`. A frame-scoped remix
     * never reached them, so they kept painting the theme's opaque surfaces. `body > *`
     * covers `#root` and every sibling in one rule.
     */
    function tokenCss(settings) {
      const captures = SURFACE_TOKENS.map((entry) => `  --dshbg-raw-${entry.raw}: var(${entry.token});`).join('\n');
      const labelCaptures = LABEL_TOKENS.map((token, index) => `  --dshbg-raw-label-${index}: var(${token});`).join('\n');
      const remixes = SURFACE_TOKENS.filter((entry) => settings.fullWindow || entry.sidebarOnly !== true)
        .map((entry) => {
          // The sidebar has its own density: that column is painted by two layers (the host
          // column and its inner root both read this one token), so the same alpha lands
          // twice and `1-(1-a)²` is what reaches the screen - it always reads darker than
          // the panels beside it. A separate number is the only way to tune it by eye.
          const alpha = entry.sidebarOnly === true
            ? clamp(settings.sidebarFill, 0, 100)
            : Math.min(100, surfaceOf(settings) + entry.lift);
          return `  ${entry.token}: color-mix(in srgb, var(--dshbg-raw-${entry.raw}) ${alpha}%, transparent) !important;`;
        })
        .join('\n');
      return `
html[data-dshbg-on] body {
${captures}
${labelCaptures}
}
html[data-dshbg-on] body > * {
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
     * The one fill every sidebar pane shares.
     *
     * The new-session button, the cost meter and the history block are three panes stacked
     * in the same column over the same wallpaper, so "how black is it" has to be one
     * number, not three. It used to be three: the meter and the button went through
     * `glassPane` (22% of `--dshbg-raw-base`), while the history block painted 52% of
     * `--dshbg-raw-l1` - a *different* token at more than twice the ratio, which is why the
     * block read as a dark slab next to a light meter. Now both read this expression, so
     * they cannot drift apart again; the smoke test asserts they contain the same string.
     *
     * 22% is the pane ratio, not a taste call: a pane sits in a column whose backdrop is
     * only wallpaper, so it can afford to be nearly clear. Controls that float *over*
     * content use `glassChip` (45%) or `glassFloat` (58%) instead.
     */
    const PANE_FILL = 22;

    function paneFill() {
      return `color-mix(in srgb, var(--dshbg-raw-base) ${PANE_FILL}%, transparent)`;
    }

    /**
     * The frosted-pane recipe, shared by every surface that gets the liquid-glass look.
     *
     * ⚠️ **Never put this on an ancestor of a menu.** `backdrop-filter` creates a backdrop
     * root, and a menu hanging outside that ancestor's box samples an empty area - its blur
     * silently does nothing. That is exactly what the composer card used to do to the `/`
     * menu, which is why `composerGlassCss` hand-rolls the pane. Leaves are fine;
     * containers that own popovers are not.
     * ⚠️ **No `backdrop-filter` here at all** (v2.47.0). The wallpaper is already blurred at
     * the `html::before` layer, so this element would pay for a full backdrop snapshot per
     * frame to re-blur something already blurred - and the frame that lost the race showed
     * bare wallpaper. That was the flicker.
     *
     * ENGINEERING.md 附录 A.11 has the full derivation.
     */
    function glassPane() {
      return `  background-color: ${paneFill()} !important;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    inset 0 -1px 0 0 rgb(0 0 0 / 0.10),
    inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 16%, transparent),
    0 10px 30px -14px rgb(0 0 0 / 0.55) !important;`;
    }

    /**
     * The small-pane variant, for inline code and the cost-detail pills.
     *
     * 45% fill against the pane's 22%: inline code has to stay distinguishable from prose,
     * and 45% is where 12px monospace still clears 5:1 on a mid-bright wallpaper. No drop
     * shadow (fifteen shadows in a paragraph is noise). Blur capped at 10px. `border` is a
     * parameter because the pills already carry the host's 1px and thinning them is visible.
     *
     * ⚠️ No `backdrop-filter`, for the same reason as `glassPane`: a paragraph with a dozen
     * chips used to take a dozen backdrop snapshots per frame while a reply streamed in.
     *
     * ENGINEERING.md 附录 A.12 has the full derivation.
     */
    function glassChip(border = '.5px') {
      return `  background-color: color-mix(in srgb, var(--dshbg-raw-base) 45%, transparent) !important;
  border: ${border} solid color-mix(in srgb, var(--dshbg-raw-label-0) 14%, transparent) !important;
  box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.08) !important;`;
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
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 16%, transparent),
    0 10px 30px -14px rgb(0 0 0 / 0.55) !important;
  -webkit-backdrop-filter: blur(${radius}px) saturate(160%) !important;
  backdrop-filter: blur(${radius}px) saturate(160%) !important;`;
    }

    /**
     * The turn navigator's hover preview.
     *
     * It sits on top of body text, not beside it, so it needs a hard 50% fill floor: at the
     * slider's low end the 12px caption fights blurred glyphs for the same pixels. Same floor
     * as the workspace hover card, because it is the same kind of surface.
     *
     * ⚠️ Matched on the response line rather than bare `_preview`, which several other
     * modules use for things that are not popovers.
     * ⚠️ No ancestor of it may carry a `backdrop-filter` - if the blur ever stops working,
     * check that chain first (see `menuSurfaceCss`).
     *
     * ENGINEERING.md 附录 A.10 has the full derivation.
     */
    function previewCardCss(settings) {
      const blur = menuBlurOf(settings);
      const shared = menuFillOf(settings);
      const fill = Math.max(shared, 50);
      return `
${prefixed('html[data-dshbg-on]', ['[class*="_preview"]:has([class*="_previewResponse"])'])} {
  background: color-mix(in srgb, var(--dshbg-raw-l1) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
}
`;
    }

    /**
     * Menus - the `/` command menu and every popover built on the same primitive.
     *
     * ⚠️ The glass goes on the **surface**, not on the `_material` child: that child is
     * `z-index: -1`, so any background the host puts on the surface covers it, and one layer
     * doing fill + blur is one compositing layer instead of two. The material layer is stood
     * down to `transparent` / `none`.
     * ⚠️ `backdrop-filter` creates a backdrop root, and the `/` menu hangs *outside* the
     * composer card. If any ancestor of it carries a blur, the menu samples an empty area and
     * its blur silently does nothing - no fill ratio can compensate. See `composerGlassCss`:
     * the card gives its backdrop-filter up.
     * ⚠️ Fill and radius are a pair, not two knobs: more radius flattens the backdrop harder,
     * so less fill is needed.
     * ⚠️ The `[data-overflow-below]` fade is re-stated, or the host's opaque gradient shows
     * as a solid band across the menu's bottom.
     *
     * ENGINEERING.md 附录 A.5 has the full derivation.
     */
    function menuSurfaceCss(settings) {
      const menu = '[class*="_menu"]:has([class*="_itemDescription"])';
      const fill = menuFillOf(settings);
      const blur = menuBlurOf(settings);
      // The glass goes on the *surface*, not on the `_material` child, and this is the whole
      // fix for "the menu blur does nothing".
      //
      // `._surface` carries `isolation: isolate`, which makes it a backdrop root: the
      // `_material` child's own `backdrop-filter` may then only sample what is painted
      // inside the surface - and inside the surface there is nothing but the material
      // layer itself. So the host's `blur(40px)` was sampling an empty box and the menu
      // behaved like a plain 45%-opaque plate. An element's own backdrop-filter is not
      // limited by the root it creates (that root is for its descendants), so painting the
      // blur on the surface samples the page properly.
      //
      // `isolation: auto` is belt and braces: the surface is already a stacking context by
      // virtue of `position: absolute; z-index: 100`, so nothing needs the isolation, and
      // dropping it removes one more way for the child to be fenced off.
      const glass = `  background: color-mix(in srgb, var(--dshbg-raw-l1) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;`;
      return `
${prefixed('html[data-dshbg-on]', ['[data-menu-material]'])} {
${glass}
  box-shadow:
    var(--dsw-elevation-prominent),
    inset 0 1px 0 rgb(255 255 255 / 0.10) !important;
}
${prefixed('html[data-dshbg-on]', [menu])} {
${glass}
  box-shadow:
    var(--dsw-elevation-prominent),
    inset 0 1px 0 rgb(255 255 255 / 0.10) !important;
}
${prefixed('html[data-dshbg-on]', ['[data-menu-material] > [class*="_material"]'])} {
  background: transparent !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
${prefixed('html[data-dshbg-on]', [`${menu}[data-overflow-below]::after`])} {
  background: linear-gradient(
    to bottom,
    transparent,
    color-mix(in srgb, var(--dshbg-raw-l1) ${fill}%, transparent)
  ) !important;
}
`;
    }

    /**
     * Tooltips and the workspace hover card.
     *
     * Both are dark by necessity: the host hardcodes `--dsw-hovercard-bg` and paints white
     * text on it, and the tooltip bubble draws a static neutral. Neither token is in
     * `SURFACE_TOKENS`, so neither followed the wallpaper. They cannot go light - the label
     * colours are hardcoded white - so they become dark *glass*: keep the host's own colour
     * through `color-mix(<host var> N%, transparent)` rather than a literal, drop the alpha,
     * blur what is behind.
     *
     * ⚠️ Hard fill floors, 50% card / 58% bubble. This surface is *inverted*: white glyphs on
     * a possibly bright backdrop disappear at the slider's low end.
     * ⚠️ The card is `body > [class*="_card_"]` because the primitive portals it onto
     * `<body>`; the bubble is `[data-side]`, which the message bubble does not carry.
     * ⚠️ The ring is an inset shadow: the card is border-box at a fixed 244px, so a border
     * would eat into its own text box.
     *
     * ENGINEERING.md 附录 A.7 has the full derivation.
     */
    function tooltipGlassCss(settings) {
      const blur = menuBlurOf(settings);
      const shared = menuFillOf(settings);
      // Inverted surfaces: hard floors, see the note above.
      const cardFill = Math.max(shared, 50);
      const bubbleFill = Math.max(shared, 58);
      return `
${prefixed('html[data-dshbg-on]', ['body > [class*="_card_"]'])} {
  background: color-mix(in srgb, var(--dsw-hovercard-bg) ${cardFill}%, transparent) !important;
  box-shadow: var(--dsw-shadow-lv3), inset 0 0 0 1px rgb(255 255 255 / 0.10) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
}
${prefixed('html[data-dshbg-on]', ['[class*="_bubble_"][data-side]'])} {
  background: color-mix(in srgb, var(--dsw-alias-tooltip-bg) ${bubbleFill}%, transparent) !important;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.10) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
}
`;
    }

    /**
     * Glass inside the transcript: code blocks, file cards, deliverable cards, inline code.
     * Always on - these are content, not chrome, so they ignore the composer's finish switch.
     *
     * Hooks, never hashed classes: `[class*="_block_"]:has([data-code-block-banner])` with
     * `.md-code-block` as the fallback when no banner is rendered (no language, still
     * streaming), `[class*="_fileCard"]`, `[data-presented-file]`, and
     * `[class*="_markdown_"] :not(pre)>code`.
     *
     * ⚠️ `_bannerWrap` is a *lid*, not a surface: it is `sticky; top: 0` and must keep a
     * fill, or code scrolls under the language label. It borrows the composer's material.
     * ⚠️ `[class*="_banner"]` matches `_bannerWrap` **and** `_banner` - separate rules, that
     * order.
     * ⚠️ Three things paint the block colour (`_block`, `pre`, `_banner`); clearing the two
     * custom properties on the wrapper covers all three, since both are inherited.
     *
     * ENGINEERING.md 附录 A.1 has the full derivation.
     */
    function transcriptGlassCss(settings) {
      // The banner borrows the *composer's* material rather than inventing its own number.
      // Two reasons, and the second one is the interesting one:
      //
      //  1. It is the same kind of surface in the user's eye - a frosted strip you read
      //     through - so it should read as the same material, not as a second dialect of
      //     glass sitting 200px above the input box.
      //  2. The host gives `_bannerWrap` `position: sticky; top: 0; z-index: 6`, so lines of
      //     code pass *underneath* it. What hides them is the blur, not the fill: at 50% fill
      //     the code is still plainly readable, and at `blur(50px)` it is gone. A number
      //     tuned by "how dark does the bar look" would have missed that entirely - the
      //     earlier 86%-fill version hid the code by making the bar almost solid, which is
      //     exactly what the user rejected.
      //
      // Same defaults as `composerGlassCss`, so the two cannot drift apart.
      const bannerFill = clamp(settings.composerSurface, 0, 100);
      const bannerBlur = menuBlurOf(settings);
      // A comma inside one item would leave its tail unprefixed, so these stay separate
      // entries and are spread into every rule that needs them.
      const blocks = [`[class*="_block_"]:has([data-code-block-banner])`, `.md-code-block`];
      const inlineCode = `[class*="_markdown_"] :not(pre) > code`;
      // The user's own message. `_bubble` paints `--dsw-specific-bubble`, another token
      // that is not in the remix list, so it stays the theme's opaque grey no matter what
      // the wallpaper is doing. Scoped by the flow item's `data-chat-flow-kind="user"` so
      // the same local name in other modules (trajectory, terminal) is not touched.
      // Scoped by the flow item's kind so the same local name in other modules (trajectory,
      // terminal, goal input, question reply) is not touched.
      //
      // **Three kinds, not one.** Only the first user message of a conversation is
      // `flow-kind="user"`; a prompt added mid-turn arrives as `steering`, and a queued
      // follow-up as `turn-trigger`. Matching just `user` gave the "only the first message
      // gets glass" behaviour. `_userRow` is the fallback for whatever kind the host adds
      // next - it is the row that wraps this bubble and nothing else.
      const bubble = [
        '[data-chat-flow-kind="user"] [class*="_bubble"]',
        '[data-chat-flow-kind="steering"] [class*="_bubble"]',
        '[data-chat-flow-kind="turn-trigger"] [class*="_bubble"]',
        '[class*="_userRow"] [class*="_bubble"]',
      ];
      // Separate array entries, never one comma-joined string: `prefixed()` prefixes each
      // *item*, so a comma inside an item would leave its tail unprefixed.
      const deliverable = ['[data-presented-file]', `[class$="_file"]:has(> [class$="_fileBody"])`];
      // The turn's changed-files card (`已编辑 N 个文件`). Its body paints
      // `--dsw-alias-bg-layer-1`, which is in the remix list, but its **header** paints
      // `--changes-fill`, which the host pins to `--dsw-static-neutral-850` in the dark
      // theme - a static near-black no token can reach. So the card read as a black bar on a
      // translucent body. Both halves are fixed together: the card gets the pane recipe, and
      // those two custom properties are stood down (which also kills the static hover tint).
      const changed = '[data-changed-files]';
      // ---- 代码块要自己裁圆角，用 `overflow: clip`（v2.48.1）----
      //
      // 表头是 `position: sticky; top: 0` 的盖子，会跟着滚动往下滑。滑到最远时它的**下沿
      // 正好压在外壳的下沿上**（sticky 的极限位移 = 外壳高 − 表头高，那一刻两者底边重合）。
      // 表头下两角是直角、外壳下两角是圆角，而外壳**不裁子元素** —— 于是表头的深色填充铺到
      // 外壳圆角外面，左下右下变成方角，圆角上只剩一道弧线。用户截图就是这个。
      //
      // 顶上是反过来的、而且本来就没问题：外壳上两角是直角、表头是圆角，两者半径相同，
      // 一叠正好合成一个圆角。
      //
      // 修法**不是**给表头补 `border-radius: inherit` —— 那只管顶部，管不到「表头滑到底」
      // 这个真正的现场。要修的是「外壳不裁」这件事本身。
      //
      // ⚠️ **`clip` 不是 `hidden`，这两个不能换。** `overflow: hidden` 会建立滚动容器，
      // sticky 的参照物变成它自己（而它不滚动）→ 表头彻底不再粘，代码直接盖到语言标签上。
      // `overflow: clip` 不建滚动容器，只按圆角裁，sticky 照旧相对转写区滚动。
      // 实测 `diag/banner-clip.html`：`hidden` 位移 0/72（死了），`clip` 位移 72/72（活着）。
      //
      // 这条注释不能写进下面的模板字符串：CSS 里出现块注释会被「no stray block comments」
      // 拦下，而注释里只要有反引号就提前闭合模板字符串。两种各炸过一次。
      //
      // ---- 表头不许自带圆角（v2.48.2，用户「先做 2」）----
      //
      // 宿主的表头自己写着 `border-top-left/right-radius: <同一个半径>`。**没吸顶时它是对的**：
      // 表头圆角 + 外壳圆角半径相同，一叠正好是一个角。
      //
      // 但表头是 `sticky; top: 0`。块滚到一半、表头吸在视口顶上时，**外壳的圆角已经滚出屏幕**，
      // 表头的圆角还在 —— 那两个弧挖出两个缺口，缺口里露出的是外壳（方角）自己的填充。
      // 用户的原话：「文本框什么也不干，在表头的左上右上会出现文本框的直角」。
      // 实测 `diag/banner-lid.cjs` 的 4 倍放大图里，右上角那个方块就是它。
      //
      // 修法**不是**给表头补半径（第一版就是这么错的），而是**把表头的半径摘掉**，让圆角只由
      // 外壳的 `overflow: clip` 提供：
      //   - 没吸顶：外壳裁一次，表头看上去仍然是圆的（半径一样，逐像素相同）
      //   - 吸顶：外壳的圆角在屏幕外，表头是方的，缺口不存在
      // 这就是「圆角永远由容器给，子元素一个角都不要自己声明」。
      return `
${prefixed('html[data-dshbg-on]', ['[class*="_fileCard"]', ...deliverable, ...bubble, changed])} {
${glassPane()}
}
${prefixed('html[data-dshbg-on]', [changed])} {
  --changes-fill: transparent !important;
  --changes-hover: color-mix(in srgb, var(--dshbg-raw-label-0) 8%, transparent) !important;
}
${prefixed('html[data-dshbg-on]', blocks)} {
  --dsl-code-block-background: transparent !important;
  --dsl-code-block-banner-background-color: transparent !important;
${glassPane()}
  overflow: clip !important;
}
${prefixed('html[data-dshbg-on]',
  blocks.flatMap((b) => [`${b} [class*="_banner"]`]),
)} {
  background: transparent !important;
}
${prefixed('html[data-dshbg-on]', blocks.flatMap((b) => [`${b} pre`]))} {
  background: transparent !important;
}
${prefixed('html[data-dshbg-on]', blocks.flatMap((b) => [`${b} [class*="_bannerWrap"]`]))} {
  background-color: color-mix(in srgb, var(--dshbg-raw-base) ${bannerFill}%, transparent) !important;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    inset 0 -1px 0 0 rgb(0 0 0 / 0.22) !important;
  -webkit-backdrop-filter: blur(${bannerBlur}px) saturate(160%) !important;
  backdrop-filter: blur(${bannerBlur}px) saturate(160%) !important;
}
${prefixed('html[data-dshbg-on]',
  blocks.flatMap((b) => [`${b} [class*="_banner"]`, `${b} [class*="_header_"]`]),
)} {
  border-top-left-radius: 0 !important;
  border-top-right-radius: 0 !important;
}
${prefixed('html[data-dshbg-on]', [inlineCode])} {
${glassChip()}
}
`;
    }

    /**
     * The message box, on its own switch.
     *
     * `backdrop-filter` makes an element a backdrop root, and the `/` command menu is a
     * descendant of this card that hangs *outside* its box (`bottom: calc(100% + 4px)`), so
     * a blur here would starve the menu's own blur. Two attempts at dodging that - a
     * `::before` with `z-index: -1`, and the same with `isolation` swapped for `z-index` -
     * both rendered the fill and never the blur. So the blur lives on the card itself, which
     * is the pattern the transcript cards prove works, and the menu is handled by state:
     * `installComposerMenuGuard` flips `data-dshbg-menu` on `<html>` while a menu is open and
     * the second rule below drops this card's blur for that moment. The menu then gets its
     * own blur back; the composer keeps its density throughout.
     *
     * Density is the user's "输入框不透明度" (`composerSurface`), not the menu fill: this is
     * the one surface with a caret on it, so how much wallpaper is acceptable under your own
     * typing is its own dial - and it has to work in solid *and* glass mode, which is what
     * the token route in `composerCss` and this rule now share.
     */
    function composerGlassCss(settings) {
      if (settings.composerStyle !== 'glass') return '';
      const blur = menuBlurOf(settings);
      const fill = clamp(settings.composerSurface, 0, 100);
      return `
${prefixed('html[data-dshbg-on]', ['[data-composer-card]'])} {
  position: relative !important;
  background-color: color-mix(in srgb, var(--dshbg-raw-base) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(160%) !important;
  backdrop-filter: blur(${blur}px) saturate(160%) !important;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 16%, transparent),
    0 10px 30px -14px rgb(0 0 0 / 0.55) !important;
}
${prefixed('html[data-dshbg-on][data-dshbg-menu]', ['[data-composer-card]'])} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
`;
    }

    /**
     * The right-hand sidebar (dockkit panes).
     *
     * The panel root `[data-sidebar-right-panel]` is a bare `position: absolute` box with
     * no background of its own - the visible surface is painted further down, on the
     * dockkit host/pane. So the glass goes on the root, and the layers underneath are told
     * to stop painting: otherwise the host's own fill would sit on top of the glass and
     * nothing would show through.
     *
     * **`[data-sidebar-right-open]` is not optional.** The root is permanent - it keeps its
     * box while the sidebar is closed and hides its contents with
     * `transform: translateX(var(--dsh-sidebar-width)); visibility: hidden`. Painting a
     * background on it unconditionally puts a full-width pane of glass over the transcript
     * even when there is nothing in the sidebar, which is exactly what happened. The
     * attribute is a boolean the host sets while the panel is open, so gate on it.
     *
     * Same fill and radius as the menu and the composer. No `backdrop-filter` problem here
     * in reverse: this root *is* a backdrop root for anything inside it, but the only
     * popovers that open inside the right sidebar are its own tab menus, which are portalled
     * out to `<body>` by the host's menu primitive.
     */
    function rightPanelGlassCss(settings) {
      const blur = menuBlurOf(settings);
      const fill = menuFillOf(settings);
      const panel = '[data-sidebar-right-panel]';
      return `
${prefixed('html[data-dshbg-on]', [`${panel}[data-sidebar-right-open]`])} {
  background: color-mix(in srgb, var(--dshbg-raw-l1) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
}
${prefixed('html[data-dshbg-on]', [
  `${panel} [data-dockkit-host]`,
  `${panel} [data-dockkit-pane]`,
  `${panel} [data-dockkit-float]`,
])} {
  background-color: transparent !important;
}
`;
    }

    /**
     * The block behind the sidebar's history list.
     *
     * ⚠️ Shrink-wraps its content (`flex: 0 1 auto` on wrapper and scroller), not `flex: 1` -
     * a `0%` basis inside an auto-height parent collapses the block to its padding.
     * ⚠️ Insets are measured, not guessed: 2px left, 2px + the list area's cancelled edge on
     * the right, so the block lines up with the new-session button and the cost meter.
     * ⚠️ The 6px vertical padding keeps a hovered row's square corner out of the rounded one.
     * ⚠️ The host's `_fade` is switched off - it is pinned to the column bottom and would dim
     * the last session.
     * ⚠️ The fill is `paneFill()`, the same expression the meter and the button use. Sharing
     * the expression is the only version of "same blackness" that cannot drift.
     * ⚠️ The ring is an inset shadow, not a border: these boxes are content-box, so a real
     * 1px border grows the block 2px per axis and the edges stop lining up.
     *
     * ENGINEERING.md 附录 A.4 has the full derivation.
     */
    function historyBlockCss(settings) {
      const block = '[class*="_treeBody"]';
      return `
${prefixed('html[data-dshbg-on]', [block])} {
  flex: 0 1 auto !important;
  margin-left: 2px !important;
  margin-right: calc(var(--dsh-session-list-edge-inset) + 2px) !important;
  padding: 6px 0 !important;
  background-color: ${paneFill()} !important;
  border-radius: 8px !important;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 16%, transparent),
    inset 0 1px 0 0 rgb(255 255 255 / 0.06) !important;
}
${prefixed('html[data-dshbg-on]', [`${block} [class*="_list"]`])} {
  flex: 0 1 auto !important;
}
${prefixed('html[data-dshbg-on]', [`${block} [class*="_fade"]`])} {
  display: none !important;
}
`;
    }

    /**
     * Glass inside the sidebar - the new-session button and the cost meter.
     *
     * Gated on whole-window scope: in work-area scope the sidebar is deliberately left as the
     * theme paints it, and frosting a button on an opaque panel refracts nothing.
     *
     * ⚠️ The meter keeps an explicit `width` (a percentage of the same containing block the
     * button uses) plus `calc` for the button's margins. `width: auto` hands it back to the
     * flex algorithm and it shrinks to its longest line - that was the 28px shortfall.
     * ⚠️ `[class$=...]`, not `[class*=...]`: every child is named `_newSessionContent`,
     * `_newSessionLabel`, … and would get its own border and shadow.
     *
     * ENGINEERING.md 附录 A.6 has the full derivation.
     */
    function sidebarGlassCss(settings) {
      if (!settings.fullWindow) return '';
      const meter = '.cm-footer-stack.summary:not(.rail)';
      return `
${prefixed('html[data-dshbg-on]', ['[class$="_newSession"]'])} {
${glassPane()}
}
${prefixed('html[data-dshbg-on]', [meter])} {
${glassPane()}
  width: calc(100% - 4px) !important;
  margin-inline: 2px !important;
}
${prefixed('html[data-dshbg-on][data-windows-titlebar]', [meter])} {
  width: calc(100% - 2px) !important;
  margin-left: 0 !important;
}
${historyBlockCss(settings)}`;
    }

    /**
     * Glass on the composer's status row, the session-header chips, and the cost entries.
     *
     * Gated on the finish switch with the composer: the status row is composer chrome sitting
     * directly under the message box, so "solid" has to mean solid here too.
     *
     * ⚠️ `:not([class*="_trigger"])` keeps popover openers bare - a permanent pill around a
     * dropdown reads as a button that never unpresses. The popover that opens is where the
     * glass belongs.
     * ⚠️ The `.cm-btn` cost entries keep the host's `1px` border width, only the colour
     * moves; the other chips have no border and get the `.5px` hairline.
     *
     * ENGINEERING.md 附录 A.8 has the full derivation.
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
${glassPane()}
}
${prefixed('html[data-dshbg-on]', [`${headerSlot} button:not([class*="_trigger"])`])} {
${glassChip()}
}
${prefixed('html[data-dshbg-on]', [`${dock} .cm-btn`])} {
${glassChip('1px')}
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
     * ⚠️ `[data-team-panel]`, not the header slot: the panel is portalled into
     * `document.body`, so a slot-scoped selector silently matches nothing.
     * ⚠️ Member cards get **no fill at all**. The chip recipe was tried and failed: its fill
     * derives from the wallpaper's tone, so over a dark wallpaper the "chip" came out as a
     * dark navy block. No fill has no such failure mode.
     * ⚠️ `button[class*="_member"]`: the children are `_memberName`, `_memberText`,
     * `_memberDot`, `_memberModel`, so neither `$=` nor a bare `*=` picks out the card alone.
     *
     * ENGINEERING.md 附录 A.9 has the full derivation.
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
     * Window chrome: the drag strip and the title-bar buttons.
     *
     * In work-area scope the strip is left exactly as the layout paints it - one solid slice
     * of sidebar colour across the full width. In whole-window scope it clears, because the
     * wallpaper is meant to run behind the whole window.
     *
     * ⚠️ The strip carries colour, never `backdrop-filter`. It sits *above* the columns, and
     * the columns' glass is a token remix with no blur - a blurring strip is sharper or
     * blurrier than what it borders and stands out either way.
     * ⚠️ Do not derive geometry from `--dsh-windows-sidebar-width`: it is the *track* width
     * and collapses to 0px when the sidebar closes.
     * ⚠️ The sidebar column stops painting its own fill in whole-window scope; two layers of
     * the same 40% land as 64% and read as a black column.
     *
     * ENGINEERING.md 附录 A.3 has the full derivation.
     */
    function chromeCss(settings) {
      const sidebar = clamp(settings.sidebarFill, 0, 100);
      const chat = clamp(settings.chatSurface, 0, 100);
      const strip = settings.fullWindow
        ? `background: linear-gradient(to right,
    color-mix(in srgb, var(--dshbg-raw-sidebar) ${sidebar}%, transparent) 0,
    color-mix(in srgb, var(--dshbg-raw-sidebar) ${sidebar}%, transparent) var(--dsh-windows-sidebar-width, 0px),
    color-mix(in srgb, var(--dshbg-raw-base) ${chat}%, transparent) var(--dsh-windows-sidebar-width, 0px)) !important;`
        : 'background: var(--dshbg-raw-sidebar) !important;';
      const column = settings.fullWindow
        ? `${prefixed('html[data-dshbg-on]', [
            `${frameSelector()} > div:nth-of-type(1):has([class*="_root"])`,
          ])} {
  background-color: transparent !important;
}
`
        : '';
      return `
html[data-dshbg-on][data-windows-titlebar] ${frameSelector()}::before { ${strip} }
html[data-dshbg-on][data-windows-titlebar] ${frameSelector()} { --dsh-windows-content-radius: 0px; }
${column}`;
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
      // The page must **not** paint an opaque sheet. Being the page where the background is
      // configured, it is the one place that must show that background - pinning it to
      // `--dshbg-raw-base` (a near-black neutral) is what made opening the plugin hide the
      // wallpaper behind a black sheet. So the columns it lives in simply stop painting, in
      // exactly the area the wallpaper covers.
      const scope = settings.fullWindow ? [frameSelector()] : workAreaColumns();
      return `
${prefixed('html[data-dshbg-on][data-dshbg-config]', scope)} {
  background-color: transparent !important;
  background-image: none !important;
  color: var(--dshbg-raw-label-0) !important;
${restores}
}
`;
    }

    /**
     * Host dialogs and everything else popup-shaped.
     *
     * The settings modal is the one surface that had no recipe here, so it stayed a nearly
     * opaque dark slab while the composer and the menus became glass - the "make every popup
     * consistent with the dialog" complaint. It now uses the same pair as the menus
     * (`menuFill` / `menuBlur`), with a floor so a dialog full of 13px text never goes too
     * clear on its own.
     *
     * It is keyed on `role="dialog"` + `aria-modal` because those are semantics the host's
     * JSX owns: a hashed class would break on the next build and the rule would fail
     * silently.
     */
    function dialogCss(settings) {
      const fill = Math.max(menuFillOf(settings), 46);
      const blur = menuBlurOf(settings);
      return `
${prefixed('html[data-dshbg-on]', ['[role="dialog"][aria-modal="true"]'])} {
  background-color: color-mix(in srgb, var(--dshbg-raw-base) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 14%, transparent) !important;
}
html[data-dshbg-on] dialog::backdrop {
  background: rgb(0 0 0 / 26%) !important;
}
`;
    }

    /**
     * The title strip is pushed back while a dialog is open.
     *
     * A dialog is the only thing that should be in focus; the app behind it is context, and
     * over a wallpaper that context stays as bright as the dialog itself unless something
     * pushes it down. `dialog[open]` catches native `<dialog>`s (the cost meter's), the
     * attribute selector catches the host's own modals.
     *
     * **This rule used to sit on `#root` as `filter: blur() brightness()`, and that must not
     * come back.** The blur was `min(10, max(4, menuBlur / 12))`, so at a slider value of 0
     * it still emitted `blur(4px)` - which is why a "does the blur cause the flicker?" test
     * could come back inconclusive no matter what the user did. The brightness went too: a
     * 5% dim is not worth a full-window render surface.
     *
     * **Nothing here touches `#root` any more, and nothing may.** `#root` is the whole
     * application: a `filter` on it turns it into a single render surface that has to be
     * re-rastered over the full window on every frame anything inside it changes - during a
     * fast stream, every frame. It also creates a containing block, which silently breaks
     * `position: fixed` descendants. Both costs are paid for a 5% dim that the host's own
     * scrim already does. The project's rule is the same one that settled this: frost and
     * filters belong to panels that must stay readable, not to the background.
     *
     * **The title strip still has to be pushed back, and separately.** The host's scrim is
     * positioned `inset: var(--dsh-frame-chrome-top) 0 0` on purpose - it must not dim the
     * Windows caption buttons - so the strip sits *outside* it. Without this rule the strip
     * keeps full brightness while everything under it dims, and that step is exactly the
     * "dividing line" that reappears the moment a dialog opens. An inset shadow over a
     * pseudo-element is cheap: it is a paint, not a filter pass, and it never re-rasters the
     * window.
     */
    function modalCss(settings) {
      return `
html[data-dshbg-on]:has([role="dialog"][aria-modal="true"]) ${frameSelector()}::before,
html[data-dshbg-on]:has(dialog[open]) ${frameSelector()}::before {
  box-shadow: inset 0 0 0 100vmax var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 46%)) !important;
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
     * Dialogs used to get a near-opaque fill on top, on the grounds that a statistics modal
     * at panel opacity puts the wallpaper straight through the numbers. That was the right
     * call while the blur did not work; with a real frost it is what left the cost dialog as
     * a black slab. They now follow the panel density and take the menu radius, which is the
     * same trade every other over-text surface makes.
     *
     * **The painted element is `.cm-stat`, not `.cm-stat-dialog`.** Its own rule is the
     * `rgb(from … / 1)` one above, and it sits *outside* the inner card - so retargeting only
     * the inner one left an opaque sheet underneath, and the dialog looked black no matter
     * what the inner rule said. Both are retargeted now, and a nested inner card is stood
     * down so the two layers do not compose to `1-(1-a)²`.
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
    const CM_HEADER_ENTRY = '[data-slot="conversation.session.header.actions"] .cm-btn';

    function costMeterCss(settings) {
      const alpha = surfaceOf(settings);
      return `
${prefixed('html[data-dshbg-on] body', CM_PANELS)} {
  background: color-mix(in srgb, var(--dshbg-raw-l2) ${alpha}%, transparent) !important;
}
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
        previewCardCss(settings),
        menuSurfaceCss(settings),
        tooltipGlassCss(settings),
        composerGlassCss(settings),
        rightPanelGlassCss(settings),
        sidebarGlassCss(settings),
        statusGlassCss(settings),
        menuGlassCss(settings),
        dialogCss(settings),
        modalCss(settings),
        // Absolutely last: the diagnostic switch has to beat every recipe above.
      ].join('');
    }

    // ------------------------------------------------------------------- install

    /**
     * Drives the session-title marquee.
     *
     * The distance to scroll is "however much is hidden", which no CSS length expresses, so
     * it is measured here and handed to a CSS animation through `--dshbg-mq-loop` /
     * `--dshbg-mq-dur`.
     *
     * ⚠️ Measure with a `Range`, never `scrollWidth`: the range reports the text's own
     * width and stays correct while the animation runs, whereas `scrollWidth` is read off
     * the content edge the animation is moving - every re-measure would read its own output.
     * ⚠️ `min-width` is pinned while scrolling, or the shrink-to-fit box narrows as the text
     * leaves and re-fires the observer that restarted it.
     * ⚠️ The motion is a CSS animation, not WAAPI: the host re-renders the header, and a
     * JS-owned animation dies with the detached node.
     * ⚠️ Re-sync is driven by the crumbs' own observers, never a global one - the transcript
     * mutates on every streamed token.
     *
     * ENGINEERING.md 附录 A.2 has the full derivation.
     */
    function installTitleMarquee() {
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
      };

      const sync = () => {
        if (disposed) return;
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
          for (const handle of retries) clearTimeout(handle);
          resize.disconnect();
          mutations.disconnect();
          for (const crumb of document.querySelectorAll(CRUMB)) reset(crumb);
        },
      };
    }

    /**
     * Keeps the composer's frost and the `/` menu's frost from cancelling each other.
     *
     * The command menu is rendered inside `[data-composer-card]` and hangs outside its box.
     * A `backdrop-filter` on the card makes the card a backdrop root, so the menu would only
     * sample what is painted inside that root - nothing - and its own blur would silently
     * die. The two cannot be blurred at once, so this picks by state: while such a menu is
     * open `<html>` carries `data-dshbg-menu` and the card drops its blur; the menu gets its
     * own back. Closing it restores the composer.
     */
    function installComposerMenuGuard() {
      if (typeof MutationObserver === 'undefined') return { sync() {}, dispose() {} };
      const root = document.documentElement;
      let timer = 0;
      let disposed = false;

      const sync = () => {
        timer = 0;
        if (disposed) return;
        if (!root.hasAttribute('data-dshbg-on')) {
          root.removeAttribute('data-dshbg-menu');
          return;
        }
        const open = document.querySelector('[data-composer-card] [data-menu-material]') !== null;
        if (open) root.setAttribute('data-dshbg-menu', '');
        else root.removeAttribute('data-dshbg-menu');
      };

      const schedule = () => {
        if (disposed || timer !== 0) return;
        timer = setTimeout(sync, 120);
      };

      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      return {
        sync,
        dispose() {
          disposed = true;
          if (timer !== 0) clearTimeout(timer);
          observer.disconnect();
          root.removeAttribute('data-dshbg-menu');
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
      const composerMenu = installComposerMenuGuard();

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
          tag.textContent = next;
        }
        // Turning the wallpaper off also drops the `text-overflow: clip` that the marquee
        // depends on, so the animations have to follow the stylesheet, not the setting.
        marquee.sync();
        // Re-check the composer/menu trade whenever the sheet changes: a menu that stayed
        // open across a settings change still needs the card's blur dropped.
        composerMenu.sync();
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
            composerMenu.dispose();
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
            h('p', { className: 'dshbg-hint' }, text.perSourceHint),
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
              ? h('p', { className: 'dshbg-hint' }, text.globalHint)
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
                // Reset the look of *this* background, not the app. Spreading `DEFAULTS`
                // wholesale also carried `mode: 'none'`, so "restore defaults" used to turn
                // the wallpaper off; and once every source has its own set, the sliders
                // have to land on the current source rather than on whichever one `mode`
                // happened to name.
                const patch = {};
                for (const field of PRESENTATION_KEYS) patch[field] = DEFAULTS[field];
                for (const field of GLOBAL_KEYS) patch[field] = DEFAULTS[field];
                patchSettings(patch);
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
