/**
 * dsh-private-background - browser half.
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
  id: 'dsh-private-background',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    const PACKAGE = 'dsh-private-background';
    // The sidebar panel id. It is also the key of the `main` slot entry, and those two are
    // matched by string equality - a typo in one of them registers an icon that cannot
    // select anything.
    const PANEL_ID = 'custom-background';
    const SETTINGS_KEY = 'dsh.custom-background.settings.v4';
    const LEGACY_SETTINGS_KEY = 'dsh.custom-background.settings.v3';
    const DB_NAME = 'dsh-custom-background';
    const DB_STORE = 'images';
    const MAX_EDGE = 2560;
    const MAX_DATA_URL = 3_600_000;
    // A photo is re-encoded down to `MAX_DATA_URL`, so it can never get near this. Moving
    // pictures are kept byte-for-byte - re-encoding a GIF through a canvas would flatten it to
    // one frame - which means the only ceiling left is a deliberate one on the file itself.
    const MAX_MEDIA_BYTES = 96 * 1024 * 1024;
    // Wide enough for a thumbnail, small enough that a gallery of them is still a few hundred
    // kilobytes of base64 in IndexedDB.
    const POSTER_EDGE = 1280;
    // How long one wallpaper takes to trade places with the next. Long enough to read as a
    // dissolve, short enough that clicking through a gallery does not feel sticky.
    const FADE_MS = 600;
    // `prefers-reduced-motion` is honoured by not animating at all, not by animating faster.
    const reducedMotion = () => {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (failure) {
        return false;
      }
    };

    // ------------------------------------------------------------------ defaults

    const DEFAULTS = {
      mode: 'none',
      imageId: null,
      gradient: 0,
      color: '#1b2233',
      blur: 20,
      dim: 15,
      // Which part of the picture sits in the middle of the window. `50 / 50` is the same
      // centre crop the wallpaper always had; the other values exist because a portrait's
      // subject is often near an edge and `cover` was cutting them out of the frame.
      focusX: 50,
      focusY: 50,
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
        add: '添加图片或动图',
        browse: '浏览文件夹',
        browseHint: '选一个文件夹，里面已经加过的不会列出来；点一张加一张。',
        browseEmpty: '这个文件夹里没有新的图片或视频。',
        browseHidden: '张已经在图库里，没有列出来。',
        browseClose: '收起',
        empty: '还没有图片。点「添加图片或动图」选一张。',
        framing: '取景位置',
        focusX: '左右',
        focusY: '上下',
        recenter: '居中',
        framingHint: '图比窗口宽或高的时候，只有一部分能露出来。在这里拖动预览图，把人物挪回画面里；每张图各自记住自己的位置。',
        kindVideo: '视频',
        kindAnimated: '动图',
        tooLargeMedia: '这个文件太大（上限 96 MB），换一个小一点的。',
        duplicate: '这个文件已经在图库里了，已经帮你切到那一张。',
        videoFail: '这个视频播不出来，可能是编码不被支持。换一个试试。',
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
        add: 'Add image or clip',
        browse: 'Browse a folder',
        browseHint: 'Pick a folder; anything already in the gallery is left out. Click a tile to add it.',
        browseEmpty: 'Nothing new in that folder.',
        browseHidden: 'already in the gallery, so not listed.',
        browseClose: 'Close',
        empty: 'No images yet. Use "Add image or clip" to pick one.',
        framing: 'Framing',
        focusX: 'Horizontal',
        focusY: 'Vertical',
        recenter: 'Centre',
        framingHint: 'When the picture is wider or taller than the window only part of it shows. Drag the preview to bring the subject back into frame; every picture remembers its own position.',
        kindVideo: 'Video',
        kindAnimated: 'Animated',
        tooLargeMedia: 'That file is too large (96 MB limit). Try a smaller one.',
        duplicate: 'That file is already in the gallery - switched to it.',
        videoFail: 'That video will not play - the codec is probably unsupported. Try another one.',
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
      'focusX',
      'focusY',
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
        focusX: clamp(pick('focusX'), 0, 100),
        focusY: clamp(pick('focusY'), 0, 100),
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

    // ---------------------------------------------------------------- ingesting

    /** Decode an image URL into an element that has `width` / `height`. */
    function decodeImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error('decode'));
        image.onload = () => resolve(image);
        image.src = url;
      });
    }

    function decodeVideo(url) {
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.onerror = () => reject(new Error('decode'));
        // `loadeddata` is the first moment there is a frame to draw. Waiting for `canplay`
        // would mean waiting for a decoder the poster does not need.
        video.onloadeddata = () => resolve(video);
        video.src = url;
      });
    }

    /** One still frame, downscaled - the thumbnail, the preview and the luminance source. */
    function posterOf(source, width, height) {
      const scale = Math.min(1, POSTER_EDGE / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    }

    /** Shrink a photo so a 4K file does not blow the local quota. */
    function ingestPhoto(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read'));
        reader.onload = () => {
          decodeImage(String(reader.result)).then(
            (image) => {
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
                else resolve({ kind: 'photo', dataUrl, width: image.width, height: image.height });
              } catch (failure) {
                reject(failure);
              }
            },
            reject,
          );
        };
        reader.readAsDataURL(file);
      });
    }

    /** A GIF (or animated WebP / APNG) keeps its bytes: a canvas round-trip freezes it. */
    async function ingestAnimation(file) {
      const url = window.URL.createObjectURL(file);
      try {
        const image = await decodeImage(url);
        const width = image.width || 16;
        const height = image.height || 9;
        return { kind: 'animated', blob: file, poster: posterOf(image, width, height), width, height };
      } finally {
        window.URL.revokeObjectURL(url);
      }
    }

    /** A video keeps its bytes too, and its first frame becomes the poster. */
    async function ingestVideo(file) {
      const url = window.URL.createObjectURL(file);
      try {
        const video = await decodeVideo(url);
        const width = video.videoWidth || 16;
        const height = video.videoHeight || 9;
        return { kind: 'video', blob: file, poster: posterOf(video, width, height), width, height };
      } finally {
        window.URL.revokeObjectURL(url);
      }
    }

    /**
     * Route a picked file to the right pipeline.
     *
     * The test is on the MIME type, not on the frame count: a still GIF and an animated one are
     * the same file to this code, and re-encoding the still one as JPEG would cost nothing - but
     * there is no cheap way to ask "is this animated" without decoding it, and keeping the bytes
     * is correct for both.
     */
    function ingestFile(file) {
      const type = String((file && file.type) || '').toLowerCase();
      const isVideo = type.indexOf('video/') === 0;
      const isAnimated = type === 'image/gif' || type === 'image/apng' || type === 'image/webp';
      if (!isVideo && !isAnimated) return ingestPhoto(file);
      if (file.size > MAX_MEDIA_BYTES) return Promise.reject(new Error('too-large-media'));
      return isVideo ? ingestVideo(file) : ingestAnimation(file);
    }

    /**
     * Content fingerprint of an **ingested** picture, used to refuse the same artwork twice.
     *
     * Taken from what gets *stored*, not from the file that was picked. A photo is re-encoded
     * to JPEG before it is kept, so the bytes in the gallery are not the bytes on the
     * clipboard - hashing the picked file would produce a value that never matches anything
     * already saved. Hashing the stored form is also what lets pictures added before this
     * feature existed take part: their original bytes were never kept, but their stored form
     * is right there. The trade-off is that a browser upgrade which changes its JPEG encoder
     * would stop matching older entries - that direction only ever fails to block a
     * duplicate, it never blocks a new picture.
     *
     * SHA-256 when `crypto.subtle` exists (it does on both `file://` and `localhost`, the two
     * origins this page runs on), with a plain FNV-1a over the same bytes as the fallback.
     * A fingerprint is only ever compared for equality, so a non-cryptographic hash is
     * enough; the fallback exists so a page without `crypto.subtle` still blocks duplicates
     * instead of throwing on every upload.
     */
    async function digestOfIngested(ingested) {
      const bytes =
        typeof ingested.dataUrl === 'string'
          ? new TextEncoder().encode(ingested.dataUrl)
          : new Uint8Array(await ingested.blob.arrayBuffer());
      const subtle = typeof crypto !== 'undefined' ? crypto.subtle : null;
      if (subtle !== null && subtle !== undefined && typeof subtle.digest === 'function') {
        try {
          const hash = await subtle.digest('SHA-256', bytes);
          const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
          return `sha256:${hex}`;
        } catch (failure) {
          // A page that is not a secure context rejects here; fall through rather than
          // refusing every upload from then on.
        }
      }
      let forward = 0x811c9dc5;
      let backward = 0x01000193;
      for (let index = 0; index < bytes.length; index += 1) {
        forward = ((forward ^ bytes[index]) * 0x01000193) >>> 0;
        backward = ((backward + bytes[index] * (index + 1)) * 0x85ebca6b) >>> 0;
      }
      return `fnv:${bytes.length.toString(16)}:${forward.toString(16)}:${backward.toString(16)}`;
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
      // Moving pictures are measured from their poster frame. A video's first frame is not a
      // perfect proxy for its average brightness, but the alternative is sampling the live
      // element every time a slider moves, and the tone only drives black-vs-white text.
      else if (settings.mode === 'image' && activeImage !== null && activeImage.poster !== null) {
        base = await lumaOfImage(activeImage.poster);
      }
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
     * What a record is, for the code that has to paint it.
     *
     * Records written before moving pictures existed carry no `kind` at all, and every one of
     * them is a still - so a missing kind is not an error, it is the original shape.
     */
    function kindOf(record) {
      const kind = record === null || record === undefined ? null : record.kind;
      return kind === 'video' || kind === 'animated' ? kind : 'photo';
    }

    /**
     * Object URLs for the records whose pixels live in a blob.
     *
     * Created once per record per session and never revoked while the plugin is loaded. A URL
     * revoked while a box still holds it leaves that box blank mid-fade, and there is no moment
     * during a burst where revoking is provably safe - the box holding it may be three layers
     * down and still contributing. The browser releases them when the page goes away, which is
     * the only lifetime this needs.
     */
    const mediaUrls = new Map();

    function mediaUrlOf(record) {
      const known = mediaUrls.get(record.id);
      if (known !== undefined) return known;
      let url = null;
      try {
        url = window.URL.createObjectURL(record.blob);
      } catch (failure) {
        url = null;
      }
      mediaUrls.set(record.id, url);
      return url;
    }

    /**
     * The artwork on screen is a *function* of the gallery and the selected id — never a
     * second copy of it.
     *
     * Keeping a stored `activeImage` next to `settings.imageId` is exactly how "clicking
     * another picture does nothing" happened: the gallery tile wrote the id, `paint()` read
     * the stale copy, and the only place that ever set both was `addImage()` — so the
     * wallpaper was frozen on the newest upload until a reload re-derived it in `boot()`.
     * Deriving it on every commit makes that class of drift impossible to reintroduce.
     *
     * It returns a *source*, not a URL string: `css` is always a still (the poster frame, for
     * anything that moves) and `src` is what the wallpaper actually paints. Splitting the two
     * is what lets the preview and the gallery stay cheap while the wallpaper runs a video.
     */
    function activeImageOf(images, settings) {
      if (!Array.isArray(images)) return null;
      const record = images.find((item) => item.id === settings.imageId);
      if (record === undefined) return null;
      const kind = kindOf(record);
      const poster = typeof record.poster === 'string' ? record.poster : kind === 'photo' ? record.dataUrl : null;
      const width = typeof record.width === 'number' ? record.width : 0;
      const height = typeof record.height === 'number' ? record.height : 0;
      if (kind === 'photo') {
        if (typeof record.dataUrl !== 'string') return null;
        return { kind, css: `url("${record.dataUrl}")`, src: record.dataUrl, poster, width, height };
      }
      const src = mediaUrlOf(record);
      if (src === null) return null;
      return { kind, css: poster === null ? 'none' : `url("${poster}")`, src, poster, width, height };
    }

    /** Both flat views are derived from `raw`; neither is stored next to it. */
    const derive = (next) => ({
      ...next,
      settings: flatten(next.raw),
      activeImage: activeImageOf(next.images, next.raw),
    });

    /** The source to paint, or `null` when nothing should be painted at all. */
    function backgroundValue(settings, activeImage) {
      if (settings.mode === 'image') return activeImage;
      if (settings.mode === 'gradient') {
        const css = GRADIENTS[settings.gradient].css;
        return { kind: 'gradient', css, src: css, poster: null, width: 0, height: 0 };
      }
      if (settings.mode === 'color') {
        const css = `linear-gradient(${settings.color}, ${settings.color})`;
        return { kind: 'color', css, src: css, poster: null, width: 0, height: 0 };
      }
      return null;
    }

    /**
     * A stack of wallpaper boxes, one per picture in flight.
     *
     * `background-image` is not an animatable property: writing a new URL onto the element that
     * is on screen swaps the pixels in a single frame. The way out is not to animate the image
     * but to put the new picture on its own box and fade that box in.
     *
     * ⚠️ **Every box below the top one must stay fully opaque once it has arrived.** A pair of
     * half-faded boxes covers `a2 + a1 * (1 - a2)` of the background - 75% at the midpoint - and
     * the wallpaper visibly dips dark for the length of the fade. Fading a box *in* over
     * something already at 1 makes it `a2 + (1 - a2)` = 1 the whole way. Measured: see
     * `diag/fade-harness.html`.
     *
     * ⚠️ **Nothing is ever interrupted, so nothing ever jumps.** A click while a fade is running
     * does not redirect it - it just puts one more box on top. Compositing is associative, so
     * the stack still covers the screen exactly once and the newest picture is the one that ends
     * up visible. The alternative - retargeting or re-timing the fade already in flight - moves
     * the picture on screen in a single frame, which is the ghost this design exists to avoid.
     *
     * ⚠️ **This is why the wallpaper is real elements and not `html::before`/`::after`.** Two
     * pseudo-elements are exactly enough for one dissolve and not one more; a burst needs an
     * unbounded number. `syncWalls` owns the DOM for that reason - see the note there about
     * keeping the element list stable across renders.
     *
     * A slot records `blur` and `dim` **as they were when it was painted**, not as the settings
     * read now. Both are per-background, so the picture being covered has to keep its own blur
     * underneath; reading the live settings would make it morph mid-fade.
     */
    const EMPTY_LAYER = { walls: [], seq: 0 };

    /**
     * A runaway guard, not a tuning knob. Dropping the oldest box is itself a change to what is
     * on screen - it is only invisible once the ones above it have finished fading, which takes
     * FADE_MS. Twelve boxes in is far enough that the oldest is behind a dozen fades and its
     * contribution is down in the 1e-11 range, so the guard never has to be the thing that
     * decides how the burst looks. Six was too tight: a burst on top of a half-finished stack
     * dropped a box that was still 2-5% visible, and that reads as a flicker.
     */
    const MAX_WALLS = 12;

    function layerOf(settings, activeImage) {
      const source = backgroundValue(settings, activeImage);
      if (source === null) return null;
      // `value` is the still frame, so it doubles as the identity of the artwork: two boxes
      // hold the same picture exactly when their `value` matches, whatever the source kind.
      return {
        value: source.css,
        kind: source.kind,
        src: source.src,
        blur: settings.blur,
        dim: settings.dim,
        focusX: settings.focusX,
        focusY: settings.focusY,
      };
    }

    /**
     * Advance the stack by one commit.
     *
     * Moving a slider keeps the same picture and only rewrites its numbers - that path must not
     * put another box up, or every drag would fade the wallpaper against itself. Only a
     * different `value` counts as a switch.
     *
     * `seq` numbers the boxes and counts them; the settle timer keys off it, because a burst
     * only ever appends and must not be able to push the deadline out.
     */
    function advanceLayer(layer, next) {
      const want = layerOf(next.settings, next.activeImage);
      if (want === null) {
        return layer.walls.length === 0 ? layer : { walls: [], seq: layer.seq + 1 };
      }
      if (layer.walls.length === 0) {
        // Nothing on screen to dissolve from: the first picture goes up in one frame. Same rule
        // as switching the wallpaper off - a fade needs one picture to replace another.
        return { walls: [{ ...want, id: layer.seq + 1 }], seq: layer.seq + 1 };
      }
      const top = layer.walls[layer.walls.length - 1];
      if (top.value === want.value) {
        const same =
          top.blur === want.blur && top.dim === want.dim && top.focusX === want.focusX && top.focusY === want.focusY;
        if (same) return layer;
        // Same artwork, new numbers: rewrite the box in place. Spreading `want` over `top`
        // keeps the id, which is what stops a slider drag from renumbering a box on screen.
        return { ...layer, walls: layer.walls.slice(0, -1).concat([{ ...top, ...want }]) };
      }
      const walls = layer.walls.concat([{ ...want, id: layer.seq + 1 }]);
      return { walls: walls.length > MAX_WALLS ? walls.slice(1) : walls, seq: layer.seq + 1 };
    }

    let state = derive({ raw: readRaw(), settings: null, activeImage: null, images: null, luma: null });
    state = { ...state, layer: advanceLayer(EMPTY_LAYER, state) };
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
    /**
     * After the fade, promote the incoming picture to "on screen" so the next switch starts
     * from a clean stack.
     *
     * This has to be scheduled by hand: the promotion writes a new `background-image` onto the
     * bottom layer *while* the top one is still opaque, and CSS has no way to sequence that.
     * It runs when the top layer has finished fading in, so the swap underneath is never
     * visible - the same picture is already covering it.
     */
    let settleTimer = null;
    let settleSeq = -1;

    function scheduleSettle() {
      const layer = state.layer;
      if (layer.walls.length < 2) {
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = null;
        settleSeq = -1;
        return;
      }
      // Re-arm on a *new box*, and only then. Appending is the only thing a burst does, so a
      // burst does push the deadline out - by one fade, which is exactly right: the last click
      // gets its own full fade and the ones before it are already covered by then.
      if (settleTimer !== null && settleSeq === layer.seq) return;
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleSeq = layer.seq;
      settleTimer = setTimeout(settle, FADE_MS + 60);
    }

    /**
     * Once the top box has finished fading in it is the only one visible, so every box under it
     * can go. This is the moment the stack returns to one, and it is invisible by construction.
     */
    function settle() {
      settleTimer = null;
      settleSeq = -1;
      const layer = state.layer;
      if (layer.walls.length < 2) return;
      const top = layer.walls[layer.walls.length - 1];
      state = { ...state, layer: { walls: [top], seq: layer.seq + 1 } };
      scheduleSettle();
      emit();
    }

    function commit(patch, settingsPatch) {
      const raw = settingsPatch === undefined ? state.raw : applySettingsPatch(state.raw, settingsPatch);
      const next = derive({ ...state, ...patch, raw });
      // `layer` is history, not a derivation: it has to see what the *previous* commit put on
      // screen, which no function of the new state alone can recover.
      state = { ...next, layer: advanceLayer(state.layer, next) };
      if (settingsPatch !== undefined) writeRaw(state.raw);
      scheduleSettle();
      emit();
    }

    /** Stop the pending fade bookkeeping; the stylesheet is going away with it. */
    function stop() {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
      settleAt = 0;
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
          // Deferred rather than awaited: the first frame must not wait on hashing a gallery
          // of videos. Nothing depends on it being done before the user uploads - a picture
          // with no fingerprint simply cannot match yet, which is the old behaviour.
          setTimeout(() => {
            backfillDigests().catch(() => {});
          }, 1200);
        })
        .catch(() => commit({ images: [] }));
    }

    /**
     * Fingerprints for pictures saved before this feature existed.
     *
     * Their records carry no `digest`, so re-uploading one of them would add a second copy -
     * exactly what this is meant to stop. The stored form is enough to compute one, so the
     * gap is filled in after boot, one record at a time, and written back so it only ever
     * happens once per picture. A record that cannot be hashed is left alone rather than
     * dropped: losing the artwork is a much worse outcome than missing one duplicate.
     */
    async function backfillDigests() {
      const images = state.images;
      if (images === null || images.length === 0) return;
      const missing = images.filter((record) => typeof record.digest !== 'string');
      if (missing.length === 0) return;
      const filled = new Map();
      for (const record of missing) {
        try {
          const digest = await digestOfIngested(record);
          filled.set(record.id, digest);
          await putImageRecord({ ...record, digest });
        } catch (failure) {
          // Skip this one; the rest still get their fingerprint.
        }
      }
      if (filled.size === 0) return;
      // Re-read from `state` rather than reusing `images`: an upload may have landed while
      // the loop was awaiting, and its record must not be replaced by the stale snapshot.
      const next = (state.images === null ? [] : state.images).map((record) =>
        filled.has(record.id) ? { ...record, digest: filled.get(record.id) } : record,
      );
      commit({ images: next });
    }

    async function addImage(file) {
      const ingested = await ingestFile(file);
      const digest = await digestOfIngested(ingested);
      // ⚠️ **A record with no fingerprint cannot match, so comparing is meaningless until
      // they all have one.** The backfill runs 1.2s after boot, which leaves a window - and
      // "reload the plugin, then immediately try uploading the same picture again" is
      // exactly the order someone testing this would use. Closing the window here costs one
      // extra pass on the first upload of a session and nothing afterwards, because the
      // backfill skips records that already carry a digest.
      if ((state.images === null ? [] : state.images).some((record) => typeof record.digest !== 'string')) {
        await backfillDigests();
      }
      // The same artwork twice is not two tiles. Picking a file that is already in the
      // gallery means "use this one", so the duplicate is selected instead of added - and
      // the caller is told, because silently doing nothing looks like a failed upload.
      // The selection is committed *before* the throw: the throw is for the message, the
      // commit is the thing the user actually asked for.
      const duplicate = (state.images === null ? [] : state.images).find(
        (record) => typeof record.digest === 'string' && record.digest === digest,
      );
      if (duplicate !== undefined) {
        commit({}, { mode: 'image', imageId: duplicate.id });
        throw new Error('duplicate');
      }
      // Where the picture came from - **not** a path. A browser never sees a real path, and a
      // page cannot re-open a file it was handed earlier even if it did; the security model
      // is the reason wallpapers are copied into IndexedDB instead of referenced in place.
      // This triple is what does survive, and it is enough to recognise "the folder still
      // holds the file I already added" without decoding every picture in it.
      const source = {
        name: String((file && file.name) || ''),
        size: Number((file && file.size) || 0),
        lastModified: Number((file && file.lastModified) || 0),
      };
      const record = {
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        addedAt: Date.now(),
        digest,
        source,
        ...ingested,
      };
      await putImageRecord(record);
      const images = (state.images === null ? [] : state.images).concat(record);
      // A new picture inherits the look that is on screen right now. Uploading is meant to
      // change the artwork, not to throw away the sliders the user just dialled in.
      const inherited = { ...presetOf(state.raw, sourceKeyOf(state.raw)) };
      // The framing, on the other hand, is a property of the picture: inheriting a 12% offset
      // from the previous one would crop the new upload against a composition it never had.
      inherited.focusX = DEFAULTS.focusX;
      inherited.focusY = DEFAULTS.focusY;
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

    /**
     * The box the wallpaper boxes live in: one fixed, oversized element behind everything.
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
     *
     * `bleed` is sized from the **largest blur on the stack**, not per box. Each box could
     * size its own - a box only has to outgrow its own blur radius - but the box is what
     * `background-size: cover` scales against, so two sizes mean the same picture is cropped
     * differently on each side of a dissolve. One size, one crop, no drift.
     *
     * The dim is folded into `brightness()` instead of laid over as a black sheet. The two are
     * the same arithmetic - `image * (1 - alpha)` either way - but a sheet would have to sit
     * above every box on the stack, and there is no element to put it on.
     */
    function wallpaperCss(layer) {
      if (layer.walls.length === 0) return '';
      const bleed = Math.round(Math.max(...layer.walls.map((wall) => wall.blur)) * 2 + 12);
      return `
html[data-dshbg-on] { background: transparent !important; }
html[data-dshbg-on] body,
html[data-dshbg-on] #root,
html[data-dshbg-on] ${frameSelector()} { background: transparent !important; }
html[data-dshbg-on] [data-dshbg-stack] {
  position: fixed;
  top: -${bleed}px;
  left: -${bleed}px;
  width: calc(100vw + ${bleed * 2}px);
  height: calc(100vh + ${bleed * 2}px);
  z-index: -1;
  pointer-events: none;
}
html[data-dshbg-on] [data-dshbg-stack] > [data-dshbg-wall] {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  transform: translateZ(0);
  will-change: filter;
}
html[data-dshbg-on] [data-dshbg-stack] > [data-dshbg-wall] > video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  border: 0;
}
`;
    }

    /**
     * Write one wall's source onto its box.
     *
     * A still is a `background-image`; a clip has to be an element, because no CSS property
     * plays one. Both are cropped the same way - `cover` for the still, `object-fit: cover` for
     * the video - and both take their crop from the same `focusX` / `focusY`, so the composition
     * does not move when the same framing is applied to a photo and to a clip.
     *
     * The still frame is always written first, even for a video. It is what shows for the frame
     * or two before the first decoded frame lands, and it is the whole picture when reduced
     * motion says nothing should be moving.
     */
    function paintWall(box, wall) {
      const position = `${wall.focusX}% ${wall.focusY}%`;
      const still = reducedMotion();
      const image = wall.kind === 'animated' && !still ? `url("${wall.src}")` : wall.value;
      // Re-assigning the same string is not free for an animated image: some engines restart
      // the sequence, and `paint()` runs on every slider tick. Only write when it changes.
      if (box.style.backgroundImage !== image) box.style.backgroundImage = image;
      box.style.backgroundPosition = position;

      const wants = wall.kind === 'video' && !still ? 'video' : 'still';
      const had = String(box.getAttribute('data-dshbg-media') || '');
      if (had !== wants) {
        for (const child of Array.from(box.children)) child.remove();
        box.setAttribute('data-dshbg-media', wants);
      }
      if (wants !== 'video') return;

      let video = box.children.length === 0 ? null : box.children[0];
      if (video === null) {
        video = document.createElement('video');
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        box.appendChild(video);
      }
      // Tracked on a data attribute rather than on `src`: assigning `.src` reflects to the
      // attribute in a browser but not in every environment this runs in, and a needless
      // re-assignment restarts the clip from zero.
      if (video.getAttribute('data-src') !== wall.src) {
        video.setAttribute('data-src', wall.src);
        video.src = wall.src;
        const started = video.play();
        if (started !== undefined && typeof started.catch === 'function') started.catch(() => {});
      }
      video.style.objectPosition = position;
    }

    /**
     * Keep the DOM in step with `layer.walls`.
     *
     * The elements are **stable by id, never by index**: rewriting a box's `background-image`
     * while it is partly visible is the exact jump the whole design avoids, so a box may only
     * be written to at the two moments it is invisible - when it is created, and when it is
     * dropped. Keying on the index would renumber every box when the oldest one goes, and the
     * renumbering would be visible.
     *
     * The fade itself is a Web Animation, not a CSS `transition` or `animation`. That is not a
     * style choice: `paint()` rewrites the whole `<style>` element on every settings change, and
     * replacing a sheet's text restarts every animation it defines - a burst would reset the
     * boxes it had already put up. An animation attached to the element is untouched by that.
     */
    function syncWalls(host, layer) {
      if (host === null) return;
      const walls = layer.walls;
      const keep = new Set(walls.map((wall) => String(wall.id)));
      for (const child of Array.from(host.children)) {
        if (!keep.has(child.getAttribute('data-dshbg-wall'))) child.remove();
      }
      walls.forEach((wall, index) => {
        const key = String(wall.id);
        let box = host.querySelector(`[data-dshbg-wall="${key}"]`);
        if (box === null) {
          box = document.createElement('div');
          box.setAttribute('data-dshbg-wall', key);
          host.appendChild(box);
          // A single box is the first picture of a fresh stack - there is nothing to dissolve
          // from, so it lands in one frame. Only a box arriving on top of another fades.
          if (walls.length > 1 && !reducedMotion()) {
            box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease', fill: 'forwards' });
          } else {
            box.style.opacity = '1';
          }
        }
        paintWall(box, wall);
        // `brightness(1)` is a no-op filter that still costs a pass; drop it at zero dim.
        box.style.filter = wall.dim === 0
          ? `blur(${wall.blur}px)`
          : `blur(${wall.blur}px) brightness(${(1 - wall.dim / 100).toFixed(3)})`;
        // The bottom box is the floor: there is nothing under it, so it must never be
        // see-through. Two ways it can be caught mid-fade down there - it is the survivor of a
        // collapse, or the cap just dropped the box below it - and both have to be pinned.
        // Leaving the second one alone lets a burst show a sliver of the desktop through the
        // whole stack (measured: 0.7% uncovered for a few frames).
        if (index === 0) {
          for (const animation of box.getAnimations()) animation.cancel();
          box.style.opacity = '1';
        }
      });
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
     * 中间那一列自己是一个层 —— 「谁在上面」由 DOM 决定，不由谁碰巧是合成层决定。
     *
     * 这一列里装着插件所有**浮起来的东西**：输入框卡片（`position: relative` + 模糊）、
     * 代码块的 sticky 表头（宿主给 `z-index: 6`，我们又给它加了模糊）、文件卡、交付卡、
     * 底部状态栏。它们共同点是**每一件自带一个合成层**。而列本身只是一个 `position: static`
     * 的普通盒子，什么都不建 —— 于是这些层被提到**帧**的层叠顺序里去排，谁先被合成谁就在
     * 前面。正常流里那套「谁在 DOM 后面谁在上面」的规矩，对合成层根本不生效。
     *
     * 后果就是用户截图里的那一幕：宿主的文档预览（`[data-document-preview]`）铺满窗口，
     * 它本来排在后面、永远该压住聊天；但聊天这边先被合成的那几层跑到它上面去了 ——
     * 白纸文档上于是飘着一条「代码块」表头、一张文件卡、一个输入框。
     *
     * `isolation: isolate` 让这一列成为一个层叠上下文：**列里所有的层都封在列里**，列与
     * 别人的上下关系回到由 DOM 顺序决定。它不建 backdrop root（那是 `backdrop-filter` 的
     * 副作用，见 `glassPane` 的警告），所以玻璃的模糊一点没变，也不多一次快照。
     *
     * 只封中间这一列：左栏、右栏里没有跨列浮起来的东西，而多封一列就多一次被自己的
     * `z-index` 困住的机会。
     */
    function stackingCss() {
      return `
html[data-dshbg-on] ${frameSelector()} > div:nth-of-type(2) {
  isolation: isolate;
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
        // 提问工具的回执（`QuestionReplyBubble`，一行问题一行答案的那张卡）。
        //
        // 它长得像用户气泡、也确实借了宿主的 `UserMessageBubble`，但它的 flow kind 是
        // `question-reply` —— 上面三种一个都不匹配，而气泡的底色是
        // `--dsw-specific-bubble`，那个 token 不在重混名单里。两头都错过，于是它一直是
        // 主题那块不透明的灰（用户：「这个文本框没适配（这是提出问题的那个）」）。
        // 用宿主给的 `data-question-reply` 认它，比再猜一个类名稳。
        //
        // ⚠️ **`_bubbleWidth` 必须排掉。** 这张卡的 DOM 是
        // `div.BfLV8a_row > div.BfLV8a_bubbleWidth > (UserMessageBubble).BfLV8a_bubble`，
        // 外层那个 `bubbleWidth` 只是限宽壳（`max-width` + `min-width:0`，**没有
        // `border-radius`**），尺寸和气泡**完全一样**。而 `[class*="_bubble"]` 是按子串
        // 匹配的，`BfLV8a_bubbleWidth` 里就含 `_bubble` —— 于是 `glassPane()` 的填充和
        // 那圈 `inset 0 0 0 1px` 白环被画了两遍：一遍在圆角 20px 的气泡上（弧线），
        // 一遍在方角的壳上（**同一圈的直角**）。屏幕上就是「圆角里套一个方框」。
        //
        // 逐像素验过（1.3.23 的截图，DPR=1）：直边比弧线亮。单圈 16% 白画在底色上应该
        // 是 ~62，实测弧线 57–60（单圈，直边一侧还是斜线、有抗锯齿衰减），方边 84（两圈
        // 叠着：1−0.84² ≈ 29% → ~93），顶边 120（两圈的 `inset 0 1px` 高光也叠）
        // —— 亮度差就是「画了两遍」的指纹。
        '[data-question-reply] [class*="_bubble"]:not([class*="_bubbleWidth"])',
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
      // 面板里装的是宿主的预览（文档 / 文本）时，这一层**不许糊**，只留填充。
      //
      // 理由是这块表头的路径条：`PathLabel` 的 `_path` 带 `mask-image`，而「带 mask 的子树
      // 嵌在一个自带 `backdrop-filter` 的元素里」正是 Chromium 会**把整层重复合成一遍**的
      // 那一对。屏幕上就是同一行路径变成两套字叠在一起（1.3.18 的现场，量过：灰层和白色
      // 那一段同一基线、同一右端、满亮度 —— 不在填充下面，所以是重复合成，不是透出来）。
      //
      // 面板自己不糊也读得清：它背后是聊天正文，但填充在（`menuFill + 12`，一档更浓），
      // 预览页面本身是白的、满覆盖，真正需要挡的只有面板没铺满的那圈边。
      const preview = [
        `${panel}[data-sidebar-right-open]:has([data-document-preview])`,
        `${panel}[data-sidebar-right-open]:has([data-textpreview-body])`,
      ];
      return `
${prefixed('html[data-dshbg-on]', [`${panel}[data-sidebar-right-open]`])} {
  background: color-mix(in srgb, var(--dshbg-raw-l1) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
}
${prefixed('html[data-dshbg-on]', preview)} {
  background: color-mix(in srgb, var(--dshbg-raw-l1) ${Math.min(100, fill + 12)}%, transparent) !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  isolation: isolate !important;
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
     * ⚠️ **The dock is the one pane that keeps a real `backdrop-filter`.** Everything else
     * goes through `glassPane()`, which deliberately has none: the wallpaper is already
     * blurred at the `html::before` layer, so re-blurring it pays for a full backdrop
     * snapshot per frame and buys nothing. The dock is the exception because of what sits
     * *under* it, not because it is more important - it floats over the transcript, so once
     * the conversation is scrolled to the bottom there is text behind it, and a fill alone
     * lets that text read through as smudge. The composer card is the same case, which is
     * why the two now share `menuBlurOf` and the same `saturate(160%)`.
     *
     * ⚠️ **That is only safe because the dock is a *sibling* of `[data-composer-card]`, not
     * a descendant.** The card is a backdrop root; anything inside it would sample the
     * card's own interior and the blur would silently do nothing - the exact failure the
     * `/` menu hit. If the host ever moves the dock inside the card, this rule stops
     * working without an error, and the symptom is "the slider does nothing".
     *
     * ENGINEERING.md 附录 A.8 has the full derivation.
     */
    function statusGlassCss(settings) {
      if (settings.composerStyle !== 'glass') return '';
      const blur = clamp(settings.glassBlur, 0, 40);
      // The dock is the one pane that also gets a real `backdrop-filter`, and the reason is
      // in the comment on the rule below - it is a deliberate exception to the "already
      // blurred wallpaper does not get blurred again" rule, not an oversight.
      const frost = menuBlurOf(settings);
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
  -webkit-backdrop-filter: blur(${frost}px) saturate(160%) !important;
  backdrop-filter: blur(${frost}px) saturate(160%) !important;
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
     * 一条「磨砂带」：模糊挂在 `::before` 上，**不挂在元素自己身上**。
     *
     * ⚠️ 这条不是洁癖，是 1.3.22 留下的一个真 bug（1.3.25 修）。`backdrop-filter`
     * 会让元素成为**固定定位后代的包含块**，而宿主的 Tooltip 恰好是
     * `position: fixed` + 视口坐标（`_bubble_44yfq_1{position:fixed}`），并且
     * `Tooltip` 的 `portal` **默认是 false**：
     *
     *     function Mn({ …, portal: f = !1, … }) { … f ? createPortal(te, document.body) : te }
     *
     * 所以标签栏里的「新建标签」「分屏」提示、文件表头里的「自动刷新」「在…中打开」
     * 提示，全都躺在我们糊的那根 bar 子树里。真 Chromium 实测（`C:/tmp/bf.html`）：
     * 给 bar 直接加 `blur(20px)`，它里面的 tooltip 从 `(420,200)` 跑到 `(500,320)` ——
     * 正好整平移了 bar 自己的偏移。
     *
     * 挪到 `::before`（叶子，没有后代）上就没有这个副作用：同一份夹具里 tooltip
     * 老老实实待在 `(420,200)`。代价是伪元素得盖在内容**下面**，于是需要三件套：
     *
     *   - `position: relative` —— 给伪元素当定位包含块。它**不**建立 fixed 的包含块，
     *     所以对 tooltip 仍然无害；
     *   - `isolation: isolate` —— 把 `z-index:-1` 关在自己的层叠上下文里。不加这条
     *     伪元素会漏到最近的那个祖先去，实测直接跑到 `position: fixed` 的壁纸层**后面**，
     *     整条带子看不见（`C:/tmp/bf2.png` 之前那一版就是这样）；
     *   - `z-index: 1` —— 抬一层。有了 `isolation`，子树（含 fixed tooltip）成了**一个
     *     整体**，而 `[data-textpreview-content]` / `_paneBody` 是它后面的兄弟，会把
     *     tooltip 盖住。
     *
     * 顺带还躲开另一件旧事：这样路径条（`_path`，带 `mask-image`）**不会**落进一个
     * `backdrop-filter` 祖先里，也就不会触发 `rightPanelGlassCss` 里记的那次
     * 「带 mask 的子树被重复合成」（1.3.18 的现场）。
     */
    /**
     * The three declarations that *are* the frost, and nothing else.
     *
     * Split out in 1.3.30 so that every bar in the app reads them from one place: the dock's
     * tab strip, the document preview's path row and the plugin page's header had drifted
     * into three different frosts (8/50/saturate, 8/50/saturate, and — worst — no fill at all
     * with a `brightness()` bolted on). "和别处一致" has to be enforced by construction, not
     * by three functions happening to agree; `frostedSkin()` is what makes that possible.
     */
    function frostedSkin(recipe) {
      return `  background: color-mix(in srgb, var(--dshbg-raw-base) ${recipe.fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${recipe.blur}px) saturate(150%) !important;
  backdrop-filter: blur(${recipe.blur}px) saturate(150%) !important;`;
    }

    function frostedBandCss(selectors, recipe) {
      const bar = prefixed('html[data-dshbg-on]', selectors);
      const skin = prefixed(
        'html[data-dshbg-on]',
        selectors.map((selector) => `${selector}::before`),
      );
      return `
${bar} {
  position: relative !important;
  z-index: 1 !important;
  isolation: isolate !important;
}
${skin} {
  content: "" !important;
  position: absolute !important;
  inset: 0 !important;
  z-index: -1 !important;
  pointer-events: none !important;
${frostedSkin(recipe)}
}
`;
    }

    /**
     * The dock's tab strip (1.3.21).
     *
     * 用户报的是「侧边依旧很乱，和背景重叠了」：标签的标题**画到了标签自己的圆角底色
     * 外面**，压在隔壁的胶囊和壁纸上。宿主的样式表里有两个细节能指认它：
     *
     *  1. `_tab` **一个 `overflow` 都没有** —— 唯一裁字的是里面的 `_tabTitle`；
     *  2. `_tabTitle` 在「被截断」和「活动标签」两种状态下都带 `mask-image`
     *     （右侧 14~30px 的渐隐）。带 mask 的子树在这个宿主里会被**重复合成一遍**：
     *     1.3.18 的路径条（`PathLabel`，同样的形状）就是「同一行字画两套」，而这一行的
     *     渐隐段还会被画到父级底色之外 —— 屏幕上就是文字和隔壁、和壁纸叠在一起。
     *
     * 所以修法不是调颜色，是**把渲染路径改回一条**：mask 摘掉（渐隐只是锦上添花，
     * 文字本来就被 `overflow` 裁住），裁切下沉一层到标签自己身上 —— 无论标题因为什么
     * 变宽，都不可能再画到自己的底色外面。
     *
     * ⚠️ `overflow: clip` 不是 `hidden`：`hidden` 会在标签上再建一个滚动容器，把
     * `_stripTabs` 的横向滚动和拖拽都改掉。`clip` 只按圆角裁，不建滚动容器。
     * ⚠️ 只碰标签和它的标题，**不碰 `[data-dockkit-strip-tabs]`**：那条 mask 是
     * 「右边还有标签」的唯一提示，而且它自己就是滚动容器，动它风险不成比例。
     *
     * ---
     *
     * **1.3.22：整条标签栏要自己「磨」一层。**
     *
     * 用户对比开关两版截图后说：标签右边还会透出「团队 ▸ AI 业务模式」这种**别的面板
     * 的字**，并自己给出了方向 —— 给这一层画个磨砂底。判断是对的，而且能指认来源：
     * 标签栏这一条**宿主自己一个底色都没有**（`_stripFill` 只有 `flex:1 1 0`，
     * `_tabStrip` 只有 padding），它一直靠**下面那个 pane 的 `background:
     * var(--dsw-alias-bg-base)`** 当底。我们把那个 token 改成半透明的之后，底下压着的
     * 那层就成了可见的背景 —— 于是别人的标题栏从标签栏里浮出来。
     *
     * 这跟市场页吸顶栏是同一道题，用的是同一个配方：**「底下的东西是内容就加模糊」**。
     * 填充只给一点点（`STICKY_FILL` 的量级），真正吃掉字的是模糊 —— 而且要比
     * `menuBlur` 大得多，`stickyHeadRecipe()` 那个 `max(menu*2, 32)` 就是为这种
     * 「12~14px 的字从底下滑过去」定的。
     *
     * ⚠️ **为什么不给圆角**：这条 strip 横跨 pane 的整个宽度，两个上角正好落在工作区
     * 那对圆角上。但工作区外面**有带圆角的裁切祖先** —— 证据是开着插件时 pane 的底色
     * 已经铺到角上，屏幕上却仍然是圆的（底色是方的，圆只能来自祖先的 `overflow`）。
     * 所以这里画方块填充是安全的：多出来的部分会被祖先按同一条弧裁掉，不需要我们
     * 自己再猜一个半径去对齐（猜错就是两道弧，正是 1.3.20 记过的坑）。
     *
     * ⚠️ **1.3.22 的原始写法（模糊直接挂在 strip 上）在 1.3.25 被换掉了。**
     * 当时只核对了「标签右键菜单是 portal 出去的」，就下结论说这块包含块安全 ——
     * 漏掉了**内联 Tooltip**（`portal` 默认 false，`position: fixed` 视口坐标），
     * 它就在这条 strip 里，会整体平移。现在模糊挪到 `::before` 上，见
     * `frostedBandCss` 的注释。
     */
    function dockStripCss(settings) {
      return `
${prefixed('html[data-dshbg-on]', ['[data-dockkit-tab]'])} {
  overflow: clip !important;
}
${prefixed('html[data-dshbg-on]', ['[data-dockkit-tab-title]'])} {
  -webkit-mask-image: none !important;
  mask-image: none !important;
}
${frostedBandCss(['[data-dockkit-strip]'], stickyHeadRecipe(settings))}`;
    }

    /**
     * 侧栏里「正在看的这个文件」的那两行：标签栏 + 路径表头。
     *
     * 标签栏是 `[data-dockkit-strip]`，`dockStripCss` 已经磨了。这里补的是它下面那一行：
     * `PreviewFrame` 的 header —— 宿主的原话是
     * `._3R73eq_header{border-bottom:.5px solid …;height:38px;padding:0 6px 0 16px}`
     * **一个底色都没有**（整份 `TextPreview.module.css` 里 header 只有尺寸和描边），
     * 所以壁纸直接从这一行穿过：用户看到的就是路径和右边四个按钮浮在花纹上。
     *
     * 认的锚点是宿主写死的 `data-textpreview-path`（`PathLabel` 上的字面量），
     * 它是 header 的**直接子元素**，而且 `PreviewFrame` 被所有预览模式共用
     * （文本 / 代码 / 图片 / PDF / Office），所以一行 `:has(> …)` 就够，不必猜
     * `_3R73eq_*` 那串哈希。
     *
     * ⚠️ 这一行里塞着 4 个内联 Tooltip（自动刷新 / 换行 / 重新加载 / 在…中打开），
     * 所以模糊只能走 `::before`；直接糊在 header 上会让这些提示整体偏移。
     * ⚠️ `relative` 在这里不改变 header 里那些 `position: fixed` 的 tooltip 的包含块，
     * 但它会让 header 成为绝对定位后代的包含块 —— 已核对：这一行里没有绝对定位的子元素
     * （唯一的 `position: absolute` 是正文里的 `_lineMark`，不在 header 里）。
     */
    function filePreviewBarsCss(settings) {
      return frostedBandCss([':has(> [data-textpreview-path])'], stickyHeadRecipe(settings));
    }

    /**
     * 提问卡片 —— 「向用户提出了几个问题」那张卡（提问中、还没答的那一张）。
     *
     * ⚠️ **它和「已答回执」是两张卡，别弄混。**（1.3.24 的教训）
     *   - 这张：`div.wnLwla_frame[data-question-key] > section.wnLwla_card`，出在**输入区**
     *     （`.wnLwla_frame` 带 composer clearance 内边距），只在等你作答时存在。
     *   - 回执：`div.BfLV8a_row[data-question-reply] > div.BfLV8a_bubbleWidth > UserMessageBubble`，
     *     出在**消息流**里，答完就一直在。用户截图里那张「有问题、有答案、右下角 21:05」
     *     的是它 —— 当初按这张（`wnLwla_card`）找直角，方向就是错的。
     *
     * 本文这一段解决的是**这张**的问题：它的底色是 `var(--dsw-specific-input-major)`，跟着
     * 「输入框不透明度」的滑块走 —— 提问卡片不是输入框，不该继承输入框的稀薄度。改用
     * 代码块表头与吸顶栏共用的配方：`paneFill()` 22% 打底 + `stickyHeadRecipe()` 的模糊
     * （`max(menu*2, 32)`，封顶 64）。底下是壁纸的大色块，22% 压不平，吃掉它的是模糊。
     *
     * ⚠️ 描边自己给：`glassPane()` 那套 inset 环（16%）+ 顶部高光，替换掉宿主的
     * `--dsw-elevation-panel`。inset 环只可能跟着自己的 20px 圆角走。
     * ⚠️ 模糊挂在这张卡上是安全的：它内部没有 `createPortal` 出去的菜单，不会被
     * backdrop root 带走（`wnLwla_*` 里没有任何 portal）。
     *
     * 那条「圆角外面套一个直角」——真正的元凶见 `chatSurfaceCss` 里 `bubble` 数组下面
     * 关于 `_bubbleWidth` 的注释：`[class*="_bubble"]` 是子串匹配，把限宽壳也画了一遍。
     */
    function questionCardCss(settings) {
      const { blur } = stickyHeadRecipe(settings);
      return `
${prefixed('html[data-dshbg-on]', ['[data-question-key] > section'])} {
  background-color: ${paneFill()} !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.10),
    inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0, #fff) 16%, transparent),
    0 10px 30px -14px rgb(0 0 0 / 0.55) !important;
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
     * The thin fill the market page's sticky header uses.
     *
     * The market page is a grid of cards on a bright wallpaper, so its bar can be almost
     * bare: blur is what hides the text scrolling under it, and a fill is only there to stop
     * the bar being pure glass. Any thicker and the bar turns into a dark band with a hard
     * edge at its top, which is a *new* seam one row down.
     *
     * ⚠️ **This number is not "how glassy a header should be", and the plugin page's bar no
     * longer uses it at all.** Six passes went into sizing that one from a column density,
     * which turned out to be painted on a layer our rule could not reach (see
     * `configHeadCss`). It now carries no fill; the only thing it sets is the blur.
     */
    const STICKY_FILL = 8;

    /**
     * The market page's sticky header, which is a different case from the plugin page's.
     *
     * It sits on top of 12px card titles with a 1px 16%-white stroke scrolling past, so its
     * frost has to be much stronger than the menus' value: at `menuBlur` that stroke
     * survives as a soft arc instead of disappearing. Hence `2x`, floored at 32 and capped at
     * 64 - past 64 the backdrop is a flat wash and the extra pixels buy nothing but GPU time.
     *
     * ENGINEERING.md 附录 A.9 has the derivation; the density argument is above
     * `STICKY_FILL`.
     */
    function stickyHeadRecipe(settings) {
      return {
        fill: STICKY_FILL,
        blur: Math.min(64, Math.max(menuBlurOf(settings) * 2, 32)),
      };
    }

    /**
     * ⚠️ There is no "how thick is the plugin page's bar" number any more, and it is worth
     * writing down why, because two of them lived here and both were wrong:
     *
     * - `headDensity` returned `1-(1-sidebarFill)²` = 64%, on the theory that the sidebar is
     *   painted twice. `chromeCss` had already stopped the second paint, so the column really
     *   is 40%, and 64% is the value that comment calls *"read as a black column"*.
     * - `headTop` then returned `sidebarFill` = 40%, as the top stop of a gradient.
     *
     * Both were fitting a fill to a surface whose fill is drawn somewhere else entirely - on
     * the marked element's `::before`, above our rule no matter what we set. See
     * `configHeadCss`. The bar now carries **no fill at all**; its colour is the wallpaper's,
     * through `backdrop-filter`, so there is nothing here to tune.
     */

    /**
     * The title bar of the plugin page - the strip that carries the "plugins" heading and
     * its refresh / add buttons.
     *
     * ⚠️ **The element is marked at runtime, it is not matched by a selector.** The bar is a
     * bare `<div>`: no `<header>`, no `role`, no `data-*`, and a build-hashed class
     * (`anW5wG_scrollBody` today, something else after the next build). There is no name to
     * point at.
     *
     * There used to be a relationship rule next to this one - `:has(+ [class*="_scrollBody"])`
     * and friends - kept as "belt and braces" for the shapes where the bar happens to be a
     * sibling of the scroll body. It has been removed, and the reason is worth keeping: on
     * the page that actually needed the glass it matched **nothing**, so the bar stayed bare
     * while the rule sat in the stylesheet and every assertion on it stayed green. A fallback
     * that cannot be observed failing is worse than no fallback - it reads as coverage while
     * covering one shape out of four, and the day a hash happens to line up it will frost a
     * whole column instead. Measure the box, mark it, and let this rule trust the mark.
     *
     * ⚠️ **A bar across the top of a scroller is not a pane, and painting it like one is
     * wrong in a way that is easy to see and hard to name.** Eight passes went into this, and
     * every wrong one is worth keeping because each looked plausible at the time:
     *
     * 1. A pair of numbers of its own (34% fill, `blur(24px)`). Read as a different
     *    material - a milky straight-edged band, no ring, no top highlight.
     * 2. `glassPane()` plus `menuBlurOf` - i.e. *borrow from a column*. That made it worse,
     *    not better: a fill thick enough to work on a column (22%) turns a bar into a raised
     *    card with a hard line on all four sides and a drop shadow under it. On screen it is
     *    a lit slab floating over the page. "More consistent" is not the same as "same
     *    recipe as everything else" - the recipe has to match what the surface *does*.
     * 3. `STICKY_FILL` + the market header's frost (8% + `min(64, max(menu*2, 32))`). The
     *    shape was right, the frost was not: 64px erases the wallpaper behind the bar, so it
     *    stopped matching the columns beside it. 「你直接把数值调到和侧边栏一样的模糊数值」.
     * 4. `STICKY_FILL` + the wallpaper's own blur. Right about the frost (the columns have no
     *    `backdrop-filter` at all - what shows through them is the wallpaper, blurred once by
     *    `paintWall()` at `settings.blur`, so "the sidebar's blur" *is* that slider), wrong
     *    about the fill, and the fill is what the eye actually reads as "same material".
     * 5. The sidebar column's *on-screen* density, `1-(1-sidebarFill)²` = 64%. Wrong: that
     *    doubling had already been fixed (see `chromeCss`), and a flat 64% is a −61 step
     *    against the wallpaper below it - a black bar lying on a lit page. 「还是有些怪」.
     * 6. A gradient from `sidebarFill` at the top to zero at the bottom. Measured properly
     *    this time (render the candidates 1:1, compare the **step** across the bar's bottom
     *    edge rather than the colour inside it), it was the best a fill could do: −2 against
     *    −35 for a flat 40% and −61 for a flat 64%. 「还是不对」.
     * 7. **No fill at all** - clear the host's backdrop and keep only `backdrop-filter`.
     *    「你不要去画，你让他模糊的反馈壁纸的颜色」. 「还是不对」.
     * 8. **What it uses now: the sidebar's own fill, flat, plus the wallpaper's blur - with
     *    the host's `::before` cleared.** This combination had never once been on screen: for
     *    six passes the host's 50% slab sat *on top of* whatever we set, so a 40% fill reached
     *    the eye as ~70% - a slab, never a panel. Clearing the pseudo is what finally makes a
     *    fill mean what it says.
     *
     * Step 7 is worth keeping in the record because it fails in a way that looks like progress.
     * With the fill at zero the only thing left is `backdrop-filter`, and a backdrop-filter is
     * a window onto **whatever is behind** - the rows scrolling under the bar included. On the
     * user's next screenshot that showed up as a bright smudge shaped like the list, floating
     * with nothing around it and fading out mid-bar where the rows stop: 「换了个背景仍然很奇怪」.
     * Measured, the smudge is `+19,+19,+19` - a *neutral* wash, i.e. blurred white text. It is
     * not the wallpaper, and no amount of blur tuning turns it into the wallpaper.
     *
     * 「我不要求他能显示出后面的文字，我只要求显示出背景」 is the spec in one line, and it rules
     * out both extremes: a colour plate is not the background (passes 1-6), and an empty bar is
     * not the background either, it is a window onto the list (pass 7). What is left is the
     * fill the **sidebar itself** is drawn with - one number, already on a slider, already on
     * screen 200px to the left. The bar and the column then agree by construction rather than
     * by taste, and there is nothing left here to fit by eye.
     *
     * Division of labour, and it is the whole design: **the fill hides the rows, the blur
     * softens them.** Neither is asked to do the other's job, which is why this rule is four
     * lines and not a gradient.
     *
     * **Why six of those were measured on a layer that was not ours.** The bar's background is
     * not painted on the bar. The host paints it on a pseudo-element of the box we mark:
     *
     *     .pageBar[data-natural]:before {
     *       content: "";
     *       height: var(--plugin-header-paint-height, var(--plugin-header-rest-height));
     *       background: var(--dsw-alias-bg-base);      ← 半透明底, `surface` 滑杆
     *       position: absolute; inset: 0 0 auto;
     *     }
     *
     * `::before` is *content* of the element, so it paints **above** the element's own
     * background and **above** the result of its `backdrop-filter`. And `--dsw-alias-bg-base`
     * is a token this plugin already rewrites (`tokenCss`), so what actually reached the screen
     * was `color-mix(base 50%, transparent)`. Which means, for six passes:
     *
     * - every fill we set was composited *under* that 50%, never instead of it - a 40% fill
     *   read as ~70%, which is why no number on the slider could ever look right;
     * - and `backdrop-filter` was working the whole time, with its result buried under a 50%
     *   slab - which is why 「没有覆盖，非常清晰」 kept coming back even when the blur demonstrably
     *   was running.
     *
     * The mark really does land on the sticky container and not on something empty: `isBand`
     * rejects `.pageHead` (it is `position: relative`, and a row inside the scroller has to be
     * out of flow), so the walk up the tree settles on the box that owns the pseudo element.
     * `lab/repro-head.html` rebuilds the page from the host's own stylesheet and prints
     * `hit=div.bar`, `::before h=56px bg=.../0.5` in its corner readout.
     *
     * ⚠️ Clearing `::before` is load-bearing, not tidying. Without that line the fill comes
     * back at `surface`'s value and the bar is a slab again - see the two screenshots
     * `lab/repro-fill-40.png` (a 70% slab) and `lab/repro-takeover-1.png` (same wallpaper,
     * only softer).
     *
     * ⚠️ **And it is scoped, because this rule subtracts rather than adds.** It removes the
     * host's own backdrop instead of putting one on top, so landing on the wrong element does
     * not frost that element - it strips it. `installConfigHead` therefore only marks a box
     * that carries the plugin page's own `--plugin-header-*` variables; see the note there.
     * 「你要改的是插件页面的那个表头，不是聊天的，工作区的，这两个的表头是好的」.
     *
     * ⚠️ **1.3.26：上面第 3 条和第 8 条里有两个数是错的，改掉了。** 这一节里大半的论证
     * 都建立在「表头该和侧栏那一列一样」上，而屏幕上的证据不支持这个前提（同一个 x 上，
     * 表头比它下面那一页亮 20 点；底下滚过去的卡片，连左边那条竖边都在带子里看得出斜坡）。
     * 具体错在两处，都是「抄了一个不属于这根带子的数」：
     *
     *   - **填充抄了侧栏的 `sidebarFill`（40）。** 宿主给这根表头画的底色本来就是
     *     `var(--dsw-alias-bg-base)` —— 也就是 **`surface` 这条滑杆**（默认 50）。我们清掉
     *     那个伪元素之后自己画，就该照宿主自己的密度画；换成侧栏那个数等于悄悄减掉 10 点，
     *     于是表头比它原本该有的样子亮一截。两根滑杆不是一回事，别互相借。
     *   - **模糊抄了壁纸的那条滑杆（`clamp(blur,0,40)`，默认 20）。** 壁纸是**整幅**糊过的
     *     大色块，20px 对它是合适的；而这条带子底下滑过的是 12~14px 的**文字**，20px 根本
     *     糊不掉它 —— 这是全应用唯一一处「带子里的字还留着形状」的地方。干同一件差事的
     *     代码框表头（`_bannerWrap`）用的是 `menuBlurOf`，宿主自己的注释原话是
     *     「at blur(50px) it is gone」。同一个差事，抄同一个数。
     *
     * 两条都**不**改成「更糊/更暗到看不见」：填充仍然是宿主原值、模糊仍然是共享的那个数，
     * 没有一个是新拟合出来的。saturate 依旧不加（见下），描边依旧不自带（宿主 `::after`
     * 已经画了一条 `border-bottom: .5px`，我们再画一条就是双线）。
     *
     * ⚠️ **1.3.27：模糊留着，填充从 `surface`(50) 降回 `PANE_FILL`(22)。** 1.3.26 修对了
     * 「别借侧栏的数」，却把对齐对象选错了 —— 它对齐的是**宿主在另一套材质里的数值**，不是
     * 屏幕上的东西。
     *
     * `--dsw-alias-bg-base` 那个 50% 是给**没有壁纸的实心主题**设计的：底色本来就是窗口底色，
     * 半透明只是让滚过去的内容若隐若现。壁纸铺上来之后，同一个 50% 就变成「把壁纸压到 56%
     * 亮度的一块板」—— 用户截图里量出来表头 81 / 壁纸 145 = **0.56**，而那句话是
     * 「让你透背景，没让你画啊」。板上没有壁纸的颜色，只有一层压暗的灰。
     *
     * 屏幕上真正该对齐的是**同一页上的 pane**：卡片、面板、列表块全用 `PANE_FILL`。
     * 同一张壁纸、同一屏、同一类差事（一块横在页面上的面），就该同一个密度 —— 而不是回到
     * 宿主在没有壁纸时的那个值。宿主那个数是给另一套材质的，跨材质照抄就是这次的问题。
     *
     * 五档填充，模糊固定 50px（`lab/repro-head-finish.html`，同页渲染两次做逐像素相减）：
     *
     * ```text
     * 填充   表头/壁纸亮度   透出峰值
     *  50%      0.67          5.0     ← 1.3.26，一块压暗的板
     *  38%      0.78          6.3
     *  30%      0.86          6.7
     *  22%      0.94          7.3     ← 现在这个
     *  12%      1.04          8.3     ← 已经没有壁纸的暗部，带子和页面糊成一片
     * ```
     *
     * 22% 不是折中数，是**唯一有出处的那个点**（pane 密度）。它两头都不靠极端：比 1.3.26
     * 透得多（0.94 vs 0.67），又比被抱怨「透出内容」的 1.3.25（40% + blur 20，透出峰值
     * **12.0**）更挡事 —— 因为挡内容是 `blur(50)` 的活，不是填充的活。填充只负责把壁纸压
     * 暗一点点（6%），让带子读作「一层」而不是「另一页」。
     *
     * ⚠️ **1.3.29：22% 也还是「画」，因为问题从头到尾不在**亮度**，在**彩度**。**
     * 用户看完 1.3.28 的对折（「全去掉」vs「22%」）之后仍然说不对，于是把两条路都拿去量
     * Lab 而不是亮度 —— 结论是：**alpha 混合本质上是在向一个中性色插值**。
     *
     *   `bg*(1-a) + base*a`
     *
     * `base` 是 `--dshbg-raw-base`（近黑的中性色），所以这个式子每加一点 a，壁纸的彩度就被
     * 稀释一点、色相被拽向那个中性色一点。量出来：宿主原样（a=50%）吃掉 **43%** 的彩度，
     * 我们 22% 吃掉 **23%**。亮度只掉 12 点，彩度掉 23% —— 屏幕上读到的就是「一块灰扑扑
     * 的板」，不管它多亮。这就是为什么前七轮一直在调那个百分数却永远调不对：
     * **那个百分数乘的是「变灰」的量，不是「变暗」的量。**
     *
     * `backdrop-filter` 的 `brightness()` / `saturate()` 是**乘性**的：
     *
     *   `bg*k`
     *
     * 它只缩放通道，色相与彩度**关系**原样保留。所以「暗一点」终于可以是「壁纸本身暗一点」，
     * 而不是「上面盖了一层」。同一次量测（未滚动，表头与它正下方同一张壁纸的台阶，Lab）：
     *
     * ```text
     *                                    ΔL*      ΔC*
     *   宿主原样 50% 底盘               -20.8     -3.83
     *   1.3.27 / 1.3.28 的 22% 叠色      -7.5     +1.01
     *   本式：无填充 + brightness(.94)   -0.6     +5.21
     *   什么都不加（纯壁纸，对照组）      +2.6     +5.28
     * ```
     *
     * 最后两行的 ΔC* 是模糊把周边更饱和的区域平均进来造成的，连对照组都有，不是本式引入的。
     * 关键是 ΔL*：**-0.6 已经落在肉眼阈值（约 ±1 L*）以内**，那条边不存在了；而 22% 的
     * -7.5 正是用户截图里那条能看见的暗带。
     *
     * 为什么不是「什么都不加」：表头文字是浅色的，全靠壁纸自己的亮度兜底，遇到很亮的壁纸
     * 会读不出来。6% 的乘性压暗在暗壁纸上量不出差、在亮壁纸上刚好救命。为什么不加
     * `saturate`：1.3.25 实测过，薄面之上再提饱和会让它比旁边任何表面都蓝 —— 而叠色一去掉，
     * 彩度本来就回来了（-23% → -4%），不需要补。
     *
     * ⚠️ **1.3.30：上面 1.3.29 那一整段作废 —— 它一直在回答一个错的问题。**
     *
     * 这一格先后钉过四个数：`sidebarFill` 40 / `surface` 50 / `PANE_FILL` 22 / 一个都没有
     * 只留 `brightness(.94)`。四次的错法不同，错因是同一个：**它一直假设这块表面该自己长一个
     * 样**。而这个应用里玻璃面早就有统一配方，1.3.30 之前是「三条带子三套数」：
     *
     * ```text
     * 标签栏 [data-dockkit-strip]                 → frostedBandCss(stickyHeadRecipe)  8% + blur + saturate
     * 文档路径条 :has(> [data-textpreview-path])  → 同一个函数                          8% + blur + saturate
     * 插件页表头 [data-dshbg-head]                → 自己拼字符串                        22% + menuBlur，后来又变成 brightness(.94)
     * ```
     *
     * 用户两句话把这件事说完了：先「调成一样的数值磨砂很难吗」，再「**在这里不要使用磨砂，
     * 这里就是模糊**」。第二句才是真正的答案 —— 前两条带子**浮在内容上**，需要一层膜把它们
     * 和底下的字隔开；而这条是**页面自己的表头**，它底下滑过的就是同一张壁纸，它需要的只是
     * 把滚上来的字糊掉，不需要变成另一种材质。
     *
     * 磨砂 = 底色 + 模糊 + 提饱和。这三样里，只有**模糊**是这条带子真正要的：
     *
     * ```text
     *   color-mix 填充   → 往中性色插值，壁纸彩度被稀释 = 一层灰膜（1.3.26/27/28 的错）
     *   saturate         → 磨砂的提饱和工序，纯模糊不需要
     *   brightness       → 1.3.29 的错，同样是往壁纸上贴一层膜
     * ```
     *
     * 所以它现在是一条**只有 `blur()` 的带子**，模糊的量取 `stickyHeadRecipe` 的
     * `blur`（与标签栏、文档路径条同一个 `menuBlur×2`、同一个 32 下限），别的什么都不加。
     */
    function configHeadCss(settings) {
      // 只要模糊。光秃秃的一条，没有任何填充/压暗/提饱和 —— 理由见上面那段。
      const { blur } = stickyHeadRecipe(settings);
      // ⚠️ 1.3.27：玻璃挂在 `::before` 上，不挂在 bar 上 —— 这是 `frostedBandCss` 的结构
      // （见它那段注释：`backdrop-filter` 会建包含块，把 bar 里那些不带 `portal` 的 fixed
      // tooltip 挪位）。宿主已经把这个伪元素占成底色板（`inset: 0 0 auto` + 高度变量），
      // 正好是「一条贴在顶上、垫在内容下面的面」，接管它比自己插一层 DOM 更省：不用动
      // React 的子树，也不会被重渲染删掉。
      //
      // ⚠️ 与 `frostedBandCss` 的三处**故意不同**，前两处因为这条带子是 `position: sticky`：
      //  - 不写 `position: relative`（宿主要它吸附，改定位就丢吸附）;
      //  - 不写 `z-index: 1`（宿主已经给了 `z-index: 2`，我们写 1 是把它**降**下去）;
      //  - 不穿磨砂（`frostedSkin` 那三行）：这里只要模糊，理由见上面。
      return `
html[data-dshbg-on] [data-dshbg-head] {
  background: transparent !important;
  isolation: isolate !important;
}
html[data-dshbg-on] [data-dshbg-head]::before {
  content: "" !important;
  position: absolute !important;
  inset: 0 !important;
  height: 100% !important;
  z-index: -1 !important;
  pointer-events: none !important;
  background: transparent !important;
  -webkit-backdrop-filter: blur(${blur}px) !important;
  backdrop-filter: blur(${blur}px) !important;
}
`;
    }

    /**
     * The document preview's path bar: **deliberately not styled.**
     *
     * This is the third bar in the app whose correct treatment is "leave it exactly as the
     * host built it", and it took three attempts to accept that.
     *
     * Its structure (from `dsh-client-ui-sidebar-documentpreview`):
     *
     *   .preview  { display: flex; flex-direction: column; height: 100% }
     *   .header   { flex: none; height: 38px; border-bottom: .5px solid … }   ← no background
     *   .content  { flex: auto; min-height: 0 }
     *
     * The row is chrome in normal flow with the scrolling document **below** it, never under
     * it, and nothing scrolls behind it either - so it needs neither fill nor frost to stay
     * legible. Both attempts to give it one made the screen worse in a different way:
     *
     *   1. `menuFill` + 60% floor -> a dark band wedged between the fully transparent file
     *      tab strip above and the pure white page below. Measured `(25,26,34)` on a band
     *      whose neighbours are the wallpaper's own `(29,33,56)`: a bar pasted on the
     *      document. Two adjacent chrome rows must be the same tone; a thinner fill is still
     *      a step, so the answer is no fill.
     *   2. transparent + `backdrop-filter` -> the row's own 12px label came back **doubled**,
     *      two copies of the same path a couple of pixels apart, both at full brightness (so
     *      not something behind a fill: our fill would have dimmed it). The host's `PathLabel`
     *      puts `mask-image` on its `_path` (`[data-path-clipped]`), and a masked subtree
     *      inside an element that has its own `backdrop-filter` is exactly the combination
     *      Chromium double-composites - and this header sits inside a pane that already has
     *      one, so we were nesting two.
     *
     * Nothing to blur + a host mask inside + a doubled label = the only move that cannot
     * produce an artifact of its own is to add nothing. This is also what the two headers the
     * user calls correct (chat, workspace) already are: bare text on the wallpaper.
     *
     * If this row ever needs work again, the lever is **not** a surface on the header - it is
     * the pane behind it (`glassPane`) or the host's own mask.
     */

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
     *
     * **⚠️ The panel is not the only thing darkening the artwork, and that is what the floor
     * of 46% missed.** The settings modal ships its own scrim as a *sibling* of the panel -
     * `div[role=presentation] > div[aria-hidden]` painting `--dsw-alias-bg-mask-1`, which is
     * `rgba(0,0,0,.5)` in the dark theme. Panel at 46% and scrim at 50% compose to
     * `1 - .54 x .50 = 73%` opaque, so the wallpaper reached the screen at 27% and the whole
     * page read as a black slab no matter how the fill slider was set. Two layers each
     * "half" is the same trap as `1-(1-a)²` in the sidebar: the number on the slider is not
     * the number on the screen. The scrim is pulled to 20% so that the panel's own fill is
     * what decides, which is also the only thing the user can see a slider for.
     *
     * **⚠️ The cards inside the dialog cannot use their own tokens at the global density.**
     * `--dsw-alias-settings-card-fill` and `--dsw-alias-bg-module-platform` are opaque
     * neutrals (#2c2c2e / #353638) whose whole job is to read as "this control is raised
     * above the panel". Remixed to 60-odd percent they land on top of an already-transparent
     * panel and compose back to ~91% - the panel turns to glass and the cards stay plastic.
     * They are re-expressed as a wash of the *label* colour instead: a white veil stays
     * lighter than whatever is under it on any wallpaper, whereas a half-transparent neutral
     * can end up the darkest thing on a bright one. Same reasoning as the dialog's own
     * controls in ENGINEERING.md A.9, and the same reason `-nav-item-active` is included.
     */
    function dialogCss(settings) {
      const fill = Math.max(menuFillOf(settings), 36);
      const blur = menuBlurOf(settings);
      return `
${prefixed('html[data-dshbg-on]', ['[role="dialog"][aria-modal="true"]'])} {
  background-color: color-mix(in srgb, var(--dshbg-raw-base) ${fill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${blur}px) saturate(150%) !important;
  backdrop-filter: blur(${blur}px) saturate(150%) !important;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dshbg-raw-label-0) 14%, transparent) !important;
  --dsw-alias-settings-card-fill: color-mix(in srgb, var(--dshbg-raw-label-0) 10%, transparent) !important;
  --dsw-alias-bg-module-platform: color-mix(in srgb, var(--dshbg-raw-label-0) 9%, transparent) !important;
  --dsw-specific-sidebar-nav-item-active: color-mix(in srgb, var(--dshbg-raw-label-0) 17%, transparent) !important;
  --dsw-specific-sidebar-nav-item-hover: color-mix(in srgb, var(--dshbg-raw-label-0) 8%, transparent) !important;
}
${prefixed('html[data-dshbg-on]', ['div[role="presentation"]:has(> [role="dialog"][aria-modal="true"]) > div[aria-hidden="true"]'])} {
  background-color: rgb(0 0 0 / 20%) !important;
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
     * 宿主把一整页东西铺在窗口上时，插件停止合成。
     *
     * 这一段是上面 `stackingCss` 的另一半。那一半解决「列里的层跑出列」，这一半解决
     * 「列里的层本来就该消失」—— 文档预览一开，聊天只是背景，可它上面凡是带
     * `backdrop-filter` 的东西（输入框、底部 dock、代码块表头、回到底部圆钮）**每一个都是
     * 独立合成层**。它们抢在预览前面画出来，就变成白纸上飘着聊天零件。
     *
     * 把模糊撤掉的代价是这几块在这一页变实一点，收益是**屏幕上没有第二套层**：
     * 填充、描边、阴影全留着，字照样清楚，只是不再取背景快照。这和 `/` 菜单那条守卫
     * （`installComposerMenuGuard`）是同一条规矩、同一个理由 —— 两个模糊不可能同时成立时，
     * 让不该在那儿的那个让位。
     *
     * 标记由 `installHostPanelGuard` 写在 `<html>` 上，只在这一页挂。
     */
    function hostPanelCss() {
      const frost = [
        '[data-composer-card]',
        '[data-composer-dock]',
        '[data-sidebar-right-panel]',
        '[class*="_bannerWrap"]',
        '[class*="_toBottom"]:not([class*="_toBottomSlot"])',
      ];
      return `
${prefixed('html[data-dshbg-on][data-dshbg-panel]', frost)} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
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
    const CM_FLOATS = ['.cm-footer-stack.simple', '.cm-simple-summary'];
    const CM_SECTION = '.cm-section';
    const CM_HEADER_ENTRY = '[data-slot="conversation.session.header.actions"] .cm-btn';

    /**
     * ⚠️ `.cm-section` gets **no** fill of its own, and that is the whole point.
     *
     * The plugin paints it with `background: rgb(from var(--dsw-alias-bg-layer-2) r g b / 1)`.
     * The `/ 1` puts the alpha back to 1 no matter how translucent the token became, so the
     * remix never reached the screen - the section was opaque by construction. It then sits
     * *inside* the settings dialog, which already paints a fill: the content column got two
     * coats while the nav beside it got one, and the wallpaper stopped dead at a vertical
     * line down the middle of the panel. That is the "费用 is a blackboard, 桌宠 is glass"
     * difference - the 桌宠 section paints no slab at all.
     *
     * Giving it a fill of our own (the old recipe, `l2` at `surface`%) only made the second
     * coat thinner, not absent: at surface 50 the column still composed to ~75% against the
     * nav's 49%. A child of a filled panel must be transparent, full stop.
     *
     * The two sidebar blocks stay filled - they are not inside any panel.
     */
    function costMeterCss(settings) {
      const alpha = surfaceOf(settings);
      return `
${prefixed('html[data-dshbg-on] body', [CM_SECTION])} {
  background: transparent !important;
}
${prefixed('html[data-dshbg-on] body', CM_FLOATS)} {
  background: color-mix(in srgb, var(--dshbg-raw-l2) ${alpha}%, transparent) !important;
}
${prefixed('html[data-dshbg-on]', [CM_HEADER_ENTRY])} {
  display: none !important;
}
`;
    }

    /**
     * The plugin market's fullscreen page (`dshmarket`, the 插件市场 tab).
     *
     * It paints its own backdrop with `--dsw-alias-bg-layer-1`, which is already in the
     * remix list - so it is translucent, not a black slab. What is wrong is the *lift*:
     * `layer-1` means "one step above a pane" and carries +8 points of opacity. This
     * element is not above a pane, it **is** the page - so opening the market drops the
     * whole window eight points darker than the chat you just came from, and it reads as
     * a separate slab even though every value in it is the remixed one.
     *
     * Keyed on the plugin's own `data-dsh-market-*` markers rather than a hashed class:
     * they are its documented fullscreen switch and survive a rebuild of its stylesheet.
     * Its own rule also writes `inset: 0`, so this element alone covers the window - the
     * `[role=dialog]` wrapper around it never paints and needs nothing here.
     *
     * ⚠️ **The cards get a label wash, not a `backdrop-filter`.** The obvious reading of
     * "make it frosted like the dialog" is to copy the dialog's blur - but the thing behind
     * a card here is the wallpaper, and that layer is already blurred by the slider. Blurring
     * a blurred image is invisible and costs one compositor layer per card. What actually
     * separates glass from plastic is the *fill*: `--dsw-alias-settings-card-fill` is an
     * opaque neutral (#2c2c2e) that the remix turns into ~60% dark, so the card reads as a
     * slab. A 10% white wash reads as glass on any wallpaper, and unlike a neutral it never
     * turns into the darkest thing on the screen. Same recipe as the settings dialog's cards.
     *
     * ⚠️ **The sticky header is the one place here that needs a real blur.** Its own rule is
     * `background: var(--dsw-alias-bg-base)`, which the remix turns into 50% - and what
     * scrolls under it is *content*: cards, prices, body text. At 50% they show straight
     * through the title, the search box and the filter chips. Judgement is the same one used
     * everywhere else - it is not "is this important", it is "what is underneath". Under a
     * sticky header the answer is text, so it gets `paneFill` + `menuBlur`, exactly like the
     * composer dock. Under a card the answer is wallpaper, so it gets the wash only.
     *
     * ⚠️ **And its `::before` needs the same treatment.** That pseudo-element is a 14px strip
     * sitting *above* the header with `background: inherit` - so it picks up the fill but not
     * the blur, and that one band keeps showing unblurred text sliding past while the rest of
     * the header is clean. It is the tell that only the visible bar was fixed.
     */
    function marketPageCss(settings) {
      const root = '[data-dsh-market-root]';
      const body = `${root} [class$="_body"]`;
      const head = `${root} [class$="_stickyHead"]`;
      // ⚠️ **This page gets a heavier fill than a chat pane, and that is not a drift.**
      // `paneFill` is 22% because a transcript is carried by its own message bubbles - the
      // page underneath only has to tint. This page is the opposite: every card is 12px
      // body text sitting straight on the page, so wherever the wallpaper turns bright the
      // text goes with it. 45% is where that stops happening and the wallpaper still reads
      // as a picture behind glass. If it ever needs to match the chat exactly, change the
      // number here - it is deliberately local, not a shared recipe.
      const pageMix = 'color-mix(in srgb, var(--dshbg-raw-base) 45%, transparent)';
      const wash = (percent) => `color-mix(in srgb, var(--dshbg-raw-label-0) ${percent}%, transparent)`;
      // ⚠️ **The fill goes on `[data-dsh-market-root]`, and it used to go on a selector
      // that never matched.**
      //
      // The first version targeted `[data-dsh-market-plugins-tab=true][data-dsh-market-
      // fullscreen=true]`. Read the market's own render: `fullscreen` is only set when
      // `tab === "themes"`, so on the **plugins** tab that selector matched nothing. The
      // rule was in the stylesheet, the assertion on it was green, and the page kept
      // painting whatever its ancestors painted - which is why tuning 22% -> 45% changed
      // nothing on screen and the band above the tab bar stayed unfilled.
      //
      // `[data-dsh-market-root]` is the element that is actually there in every surface
      // (plugins tab, sidebar panel, themes dialog). One fill, on the outermost market
      // element, so the tab bar, the scroller and the empty strip between them all sit on
      // the same density. Any of them left to an ancestor is a band at a different
      // density, and a band at a different density is exactly what reads as "一条缝".
      //
      // ⚠️ **The header is a frost pane, not a raised surface.**
      //
      // It has to sit on top of scrolling cards, so the obvious move is to fill it
      // heavily. That is wrong here: the page above it is a *different, lighter* density,
      // so any fill strong enough to hide the cards turns the header into a dark bar with
      // a hard edge at its top - a new seam, one row down. What hides the cards instead is
      // **blur**, and it has to be much stronger than the menus' value: `menuBlur` is
      // tuned to soften a menu, this has to erase 12px card titles scrolling past. A 1px
      // 16%-white card stroke is the worst case, and at `menuBlur` it survives as a soft
      // arc. Doubling it and flooring at 32 is what actually removes it.
      //
      // So: a whisper of fill (enough that the bar is not pure glass) and a big blur. The
      // header's density then equals the page's, which is the whole point - there is no
      // step left to see. Only the thin fill is shared with the plugin page's bar, through
      // `STICKY_FILL`; this heavier frost deliberately stays local to the market recipe.
      //
      // `::before` is the host's 14px strip above the header, `bottom: 100%`,
      // `background: inherit`. `inherit` copies the colour and **not** `backdrop-filter`,
      // so it was the one band that let text through unblurred. Re-blurring it is worse
      // than removing it: two adjacent `backdrop-filter` elements blur their own backdrop
      // independently and each adds its own fill, so the boundary between them is a hard
      // step. It is removed, and the scroller's own `padding-top` is removed with it, so
      // there is no strip left for it to cover.
      const { fill: headerFill, blur: headerBlur } = stickyHeadRecipe(settings);
      const headerPad = 12;
      const headerGap = 10;
      return `
${prefixed('html[data-dshbg-on]', [root])} {
  background: ${pageMix} !important;
  --dsw-alias-settings-card-fill: ${wash(12)} !important;
  --dsw-alias-settings-card-stroke: ${wash(16)} !important;
  --dsw-specific-input-major: ${wash(8)} !important;
  --dsw-alias-bg-layer-2: ${wash(8)} !important;
}
${prefixed('html[data-dshbg-on]', [body])} {
  padding-top: 0 !important;
}
${prefixed('html[data-dshbg-on]', [head])} {
  background: color-mix(in srgb, var(--dshbg-raw-base) ${headerFill}%, transparent) !important;
  -webkit-backdrop-filter: blur(${headerBlur}px) saturate(150%) !important;
  backdrop-filter: blur(${headerBlur}px) saturate(150%) !important;
  top: 0 !important;
  margin-top: 0 !important;
  padding-top: ${headerPad}px !important;
  padding-bottom: ${headerGap}px !important;
  border-radius: 0 0 16px 16px !important;
}
${prefixed('html[data-dshbg-on]', [`${head}::before`])} {
  display: none !important;
}
`;
    }

    /**
     * Native form-control popups - the `<select>` option list.
     *
     * ⚠️ **The dropdown is not a DOM element.** Chromium paints it in its own widget, so
     * nothing here can be a wallpaper or a blur; the most that is reachable is its colour.
     * Two things decide that colour, and both are outside the dialog's recipe:
     *
     *   1. The list's **backdrop** follows the page's `color-scheme`, which the host leaves
     *      light - so the list is painted over white.
     *   2. The list's **fill** is the `<select>`'s own `background-color`. The host styles
     *      selects with `--dsw-alias-bg-base` (`.iy1EbG_field select`), and this plugin
     *      remixes that token to a translucent `color-mix` - so the fill arrives at the
     *      popup as "55% of #151517" and composites over the white backdrop.
     *
     * `(127, 127, 128)` - the flat grey in the bug report - is exactly `#151517` at 55%
     * over `#ffffff`. Nothing about the dialog was wrong: the popup was reading a
     * translucent colour as if it were opaque, and a separate widget has no way to know
     * what is behind it. **A surface that is drawn outside the document's stacking context
     * cannot be translucent, ever.**
     *
     * So the recipe is the honest one - opaque rows, widget in dark mode. `color-scheme:
     * dark` also darkens the sliver of backdrop around the rows, the popup's scrollbar and
     * the hover highlight, which otherwise stays the light-theme blue.
     */
    function formControlCss() {
      return `
html[data-dshbg-on] select {
  color-scheme: dark !important;
}
html[data-dshbg-on] select option,
html[data-dshbg-on] select optgroup {
  background-color: var(--dshbg-raw-l2, #2c2c2e) !important;
  color: var(--dshbg-raw-label-0, #f9fafb) !important;
}
html[data-dshbg-on] select option:checked {
  background-color: var(--dsw-alias-state-business-primary, #3b82f6) !important;
  color: #fff !important;
}
`;
    }

    function buildCss(settings, layer, tone) {
      return [
        wallpaperCss(layer),
        tokenCss(settings),
        chatSurfaceCss(settings),
        stackingCss(),
        composerCss(settings),
        chromeCss(settings),
        captionCss(settings, tone),
        bottomRowCss(settings),
        configPageCss(settings),
        configHeadCss(settings),
        fontCss(settings, tone),
        costMeterCss(settings),
        marketPageCss(settings),
        formControlCss(),
        titleCss(),
        dockStripCss(settings),
        // 侧栏文件预览的第二行（路径 + 工具按钮）。紧挨着 `dockStripCss`，两条带子
        // 用同一份配方，中间隔着别的规则容易被人改歪。
        filePreviewBarsCss(settings),
        // Last, so the frosted panes are not re-painted by anything above.
        transcriptGlassCss(settings),
        previewCardCss(settings),
        menuSurfaceCss(settings),
        tooltipGlassCss(settings),
        composerGlassCss(settings),
        // 必须在 `composerGlassCss` 之后：那张卡上「摘壳」的规则和它同特异性（都是
        // `html[data-dshbg-on] [data-composer-card]`），只有顺序能决定谁赢。
        questionCardCss(settings),
        rightPanelGlassCss(settings),
        sidebarGlassCss(settings),
        statusGlassCss(settings),
        menuGlassCss(settings),
        dialogCss(settings),
        modalCss(settings),
        // 宿主整页预览期间把插件的模糊全部撤掉（见 `hostPanelCss`）。放在弹窗之后，
        // 因为它连 `dialogCss` 里的那点模糊也要一起让位。
        hostPanelCss(),
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

    /**
     * 宿主把一整页文档铺在窗口上时给 `<html>` 打标记，给 `hostPanelCss` 用。
     *
     * 认的是宿主自己的属性，不是长相：文档预览的外框挂着 `data-document-preview`
     * （`PreviewFrame` 把 `selected.id` 写在上面），文本预览的正文和路径条分别挂
     * `data-textpreview-body` / `data-textpreview-path`。三个都是宿主写死在 JSX 字面量里的，
     * 不随类名哈希变。
     *
     * ⚠️ **不能用 `html:has(...)` 在 CSS 里做这件事。** `:has()` 挂在 `<html>` 上、里面是
     * 后代选择器，等于要求浏览器在**每一次 DOM 变动**时重算整棵树 —— 而转写区在流式输出时
     * 每个 token 都在变。这里用一个 120ms 防抖的观察器，和 `installComposerMenuGuard` 同一
     * 套节奏：热闹的时候它一次都不跑，安静下来才量一次。
     *
     * 认不到的时候什么都不会发生（标记不挂，规则不匹配）—— 这是有意的：这份文档预览的
     * 三种形态里只要有一种换了属性，退化的结果也只是「和现在一样」，不会把别的页面弄坏。
     */
    function installHostPanelGuard() {
      if (typeof MutationObserver === 'undefined') return { sync() {}, dispose() {} };
      const root = document.documentElement;
      const PANEL = '[data-document-preview], [data-textpreview-body], [data-textpreview-path]';
      let timer = 0;
      let disposed = false;

      const sync = () => {
        timer = 0;
        if (disposed) return;
        if (!root.hasAttribute('data-dshbg-on')) {
          root.removeAttribute('data-dshbg-panel');
          return;
        }
        const open = document.querySelector(PANEL) !== null;
        if (open) root.setAttribute('data-dshbg-panel', '');
        else root.removeAttribute('data-dshbg-panel');
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
          root.removeAttribute('data-dshbg-panel');
        },
      };
    }

    const STACK_SELECTOR = '[data-dshbg-stack]';
    const STACK_ATTRIBUTE = 'data-dshbg-stack';
    /**
     * Find the plugin page's title bar and write `data-dshbg-head` on it.
     *
     * Nothing on that page can be selected by name (see `configHeadCss`), so the bar is
     * found by measuring. The anchor is the page's scroll body - the biggest box that
     * actually scrolls - and the bar is the strip that shares its left and right edges and
     * *straddles its top edge*: it starts at or above that edge and reaches down to it.
     * Those tests are what separate the bar from everything else:
     *
     *   - a row of the list starts below the scroller's top edge, so it fails the "starts at
     *     or above" test even when it is scrolled half out of view;
     *   - the window's title bar starts at x=0 instead of at the content's left edge;
     *   - the column that holds the scroller is far taller than a strip, and it is rejected
     *     outright for *containing* the scroller. That guard is the one that matters:
     *     frosting a column that contains the list turns the whole page into one backdrop
     *     root, and menus hanging outside it would then sample an empty area and silently
     *     lose their blur (the trap `glassPane` warns about).
     *
     * ⚠️ **The scroller is found by computed style, not by class name.** Keying it on
     * `_scrollBody` is exactly how the previous version managed to match nothing at all
     * while passing every test: that name is a build hash, and it is not even the same
     * element on every page. A locator that cannot be verified from the outside has to at
     * least not depend on a spelling nobody can check.
     *
     * A mis-measure here costs the bar its glass; it never costs the page its layout.
     *
     * ⚠️ **Finding a strip is not permission to paint it.** The geometry above matches the
     * header of *any* page built the same way - chat, workspace, whatever ships next - and
     * what `configHeadCss` does is not add a surface but **remove the host's** (it clears
     * `::before`). Landing on the wrong page therefore doesn't make that page's header
     * glassy, it makes it bare. So the mark is gated on a positive test only one element in
     * the app can pass: the bar writes its own `--plugin-header-*` variables onto itself.
     * Everything else is left exactly as the host drew it.
     */
    function installConfigHead() {
      const root = document.documentElement;
      if (typeof MutationObserver === 'undefined') return { sync() {}, dispose() {} };

      let marked = null;
      let lifted = false;
      let cached = null;
      let cachedAt = 0;
      let disposed = false;
      /** `window.__dshbgHeadGlass(false)` - park the treatment without restarting the app. */
      let suspended = false;

      const unmark = () => {
        if (marked === null) return;
        if (lifted) {
          marked.style.zIndex = '';
          lifted = false;
        }
        marked.removeAttribute('data-dshbg-head');
        marked = null;
      };

      /** A box the user can actually scroll, big enough to be a page body. */
      const scrollable = (node, box) => {
        if (node === root || node === document.body) return false;
        if (box.width < 320 || box.height < 240) return false;
        if (box.right < 4 || box.bottom < 4) return false;
        if (box.left > window.innerWidth - 4 || box.top > window.innerHeight - 4) return false;
        if (node.scrollHeight <= node.clientHeight + 8) return false;
        if (typeof node.checkVisibility === 'function') {
          if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        }
        const style = getComputedStyle(node);
        return style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay';
      };

      /**
       * The page's scroll body.
       *
       * `[class*="scroll"]` is only a shortcut that keeps the common case away from a full
       * walk of the document; the walk is still there for the day the class says nothing.
       * The answer is cached for a moment because the observer fires on every mutation and
       * a miss costs a `getComputedStyle` per candidate - but it expires, so a pane that
       * mounts later cannot pin the answer to the wrong page.
       */
      const scroller = () => {
        if (cached !== null && cached.isConnected && Date.now() - cachedAt < 700) return cached;
        const widest = (nodes) => {
          let best = null;
          let bestArea = 0;
          for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[i];
            if (node.nodeType !== 1) continue;
            if (node.scrollHeight <= node.clientHeight + 8) continue;
            const box = node.getBoundingClientRect();
            if (!scrollable(node, box)) continue;
            const area = box.width * box.height;
            if (area > bestArea) {
              bestArea = area;
              best = node;
            }
          }
          return best;
        };
        const best =
          widest(document.querySelectorAll('[class*="scroll" i]')) ||
          widest(document.querySelectorAll('*'));
        cached = best;
        cachedAt = Date.now();
        return best;
      };

      /** Is `node` the strip that sits on the scroller's top edge? */
      const isBand = (node, body, area) => {
        if (node === null || node.nodeType !== 1) return false;
        if (node === root || node === document.body) return false;
        // A column is not a strip - and a column that holds a scroller must never carry a
        // backdrop-filter, see the note above.
        if (node.contains(body)) return false;
        // The rows belong to the scroller and the bar does not - except in the layouts where
        // the bar is *sticky inside* the scroller, which is common enough to matter: there
        // the bar is a child and the rows are its siblings. Being out of flow is what tells
        // them apart, so the test is about position rather than containment. A plain row is
        // `static` and is rejected, including one scrolled half out of view.
        if (body.contains(node)) {
          const pos = getComputedStyle(node).position;
          if (pos !== 'sticky' && pos !== 'fixed' && pos !== 'absolute') return false;
        }
        const box = node.getBoundingClientRect();
        if (box.height < 18 || box.height > 140) return false;
        if (box.width < area.width * 0.9) return false;
        if (box.left < area.left - 12 || box.left > area.left + 40) return false;
        if (box.right < area.right - 40) return false;
        if (box.top > area.top + 4) return false;
        if (box.bottom < area.top - 4) return false;
        return true;
      };

      /** The bar under the pointer - only works while it paints above the rows. */
      const fromPoint = (body, area) => {
        if (typeof document.elementFromPoint !== 'function') return null;
        const x = Math.round(area.left + Math.min(area.width * 0.5, 320));
        const ys = [Math.round(area.top + 16), Math.round(area.top + 34), Math.round(area.top - 12)];
        for (let i = 0; i < ys.length; i += 1) {
          const y = ys[i];
          if (y < 2 || x < 2 || y > window.innerHeight - 2) continue;
          let node = document.elementFromPoint(x, y);
          let depth = 0;
          while (node !== null && depth < 8) {
            if (isBand(node, body, area)) return node;
            node = node.parentElement;
            depth += 1;
          }
        }
        return null;
      };

      /**
       * The bar as a sibling of the scroller, or of one of its ancestors.
       *
       * This is the probe that works when the host stacks the rows *above* the bar: the
       * pointer then lands on a row, `fromPoint` gives up, and only the tree still knows
       * where the bar is. It also covers the shapes where the bar is wrapped in a block of
       * its own, because the walk goes up several levels and looks at every sibling there.
       */
      const fromNeighbours = (body, area) => {
        let node = body;
        let depth = 0;
        while (node !== null && depth < 6) {
          const parent = node.parentElement;
          if (parent === null) return null;
          const kids = parent.children;
          for (let i = 0; i < kids.length; i += 1) {
            if (kids[i] === node) continue;
            if (isBand(kids[i], body, area)) return kids[i];
          }
          node = parent;
          depth += 1;
        }
        return null;
      };

      /**
       * A bar that overlaps the scroller has to paint above it, or the glass ends up under
       * the very rows it is supposed to hide - which on screen is indistinguishable from
       * "nothing happened". Only a positioned box takes a `z-index`, and only an `auto` one
       * is safe to raise: a level the host already set was set on purpose.
       */
      const lift = (head, area) => {
        const box = head.getBoundingClientRect();
        if (box.bottom <= area.top + 2) return;
        const style = getComputedStyle(head);
        if (style.position === 'static' || style.zIndex !== 'auto') return;
        head.style.zIndex = '4';
        lifted = true;
      };

      /**
       * The one thing that says "this strip is the plugin page's bar", with no class name in
       * it.
       *
       * The bar measures itself and writes its own custom properties - `rest-height`,
       * `compact-height`, `paint-height` - **onto itself**, as inline styles, from
       * `attach()` and `scroll()` in the host. Nothing else in the whole app writes those
       * three names; they appear in one package and one element. So "carries one of them" is
       * an exact answer to "is this the plugin page's bar", and it is a *positive* answer.
       *
       * ⚠️ This replaced a guard that asked the opposite question. `isChat()` looked for a
       * composer card and, if it found none, assumed the page was fair game - so every page
       * nobody had thought of (the workspace browser, a chat pane whose composer was not
       * mounted yet) got the bar treatment, and the treatment now *clears the host's own
       * backdrop*. The user's report was exactly that: 「你要改的是插件页面的那个表头，不是
       * 聊天的，工作区的，这两个的表头是好的」. A negative test cannot survive a page it has
       * never seen; a positive one cannot be surprised by one.
       */
      const HEAD_VARS = [
        '--plugin-header-rest-height',
        '--plugin-header-paint-height',
        '--plugin-header-compact-height',
      ];
      const ownsHeaderVars = (node) => {
        if (node === null || node.nodeType !== 1) return false;
        for (let i = 0; i < HEAD_VARS.length; i += 1) {
          if (node.style.getPropertyValue(HEAD_VARS[i]) !== '') return true;
        }
        return false;
      };

      /**
       * The bar itself, or `null` if this page has no plugin bar.
       *
       * The probes above can land on a child of the bar - `fromPoint` hit-tests whatever is
       * under the pointer, and the bar is `pointer-events: none` so the hit is usually its
       * `<header>`. The variables live on the bar, so climbing is what turns either answer
       * into the same element.
       */
      const barOf = (node) => {
        let found = node;
        let depth = 0;
        while (found !== null && depth < 6) {
          if (ownsHeaderVars(found)) return found;
          found = found.parentElement;
          depth += 1;
        }
        return null;
      };

      const sync = () => {
        if (disposed) return;
        // `window.__dshbgHeadGlass(false)` parks the whole treatment. Taking the mark off is
        // enough to hand the bar back to the host: every rule in `configHeadCss` is keyed on
        // `[data-dshbg-head]`, including the one that takes over `::before`, so the host's own
        // 50% backdrop and its `::after` hairline come back exactly as it built them.
        if (suspended) {
          unmark();
          return;
        }
        if (!root.hasAttribute('data-dshbg-on')) {
          unmark();
          return;
        }
        const body = scroller();
        if (body === null) {
          unmark();
          return;
        }
        const area = body.getBoundingClientRect();
        const candidate = fromPoint(body, area) || fromNeighbours(body, area);
        const head = candidate === null ? null : barOf(candidate);
        if (head === marked) return;
        unmark();
        if (head === null) return;
        head.setAttribute('data-dshbg-head', '');
        marked = head;
        lift(head, area);
      };

      /**
       * `window.__dshbgHead()` - the one-line answer to "did it find the bar, and if not,
       * what did it see". The page's shape is the one thing that cannot be read off this
       * source, so when the host reshuffles its DOM this is what turns a guessing round into
       * a measurement.
       */
      const report = () => {
        const label = (node) => {
          if (node === null) return 'none';
          const cls = typeof node.className === 'string' ? node.className.split(/\s+/)[0] : '';
          return node.tagName.toLowerCase() + (cls === '' ? '' : '.' + cls.slice(0, 28));
        };
        const rect = (node) => {
          if (node === null) return null;
          const box = node.getBoundingClientRect();
          return [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)];
        };
        const body = cached !== null && cached.isConnected ? cached : scroller();
        return {
          on: root.hasAttribute('data-dshbg-on'),
          vars: marked !== null && ownsHeaderVars(marked),
          suspended,
          scroller: label(body),
          scrollerRect: rect(body),
          marked: label(marked),
          markedRect: rect(marked),
          lifted,
        };
      };
      window.__dshbgHead = report;

      /**
       * `window.__dshbgHeadGlass(false)` / `(true)` - hand this one bar back to the host, or
       * take it back, **without a restart**.
       *
       * Written because "let me see it with nothing on it" is the only honest way to judge a
       * surface that has been through six attempts: comparing a screenshot against a memory
       * of a screenshot is how both 1.3.25 and 1.3.26 ended up shipping a wrong number. The
       * switch flips the same mark the CSS is keyed on, so what comes back is not "our recipe
       * with the numbers zeroed" - it is the host's own `::before` plate and `::after`
       * hairline, untouched.
       *
       * Cost: none. The CSS rules stay in the sheet; with the attribute absent they match
       * nothing, and no `backdrop-filter` is being paid for.
       */
      window.__dshbgHeadGlass = (on) => {
        suspended = on === false;
        if (suspended) unmark();
        else settle();
        return !suspended;
      };

      // The page mounts over several commits and the bar is not in the first one, so a
      // single pass after the attribute flips is not enough. The retries stop on their own:
      // a page with no plugin bar (chat, workspace) has nothing to mark either, and two
      // extra passes that find nothing are cheaper than a guard that has to know which page
      // it is on.
      const settle = () => {
        sync();
        if (disposed) return;
        if (marked === null && root.hasAttribute('data-dshbg-on')) {
          setTimeout(sync, 70);
          setTimeout(sync, 260);
        }
      };

      let timer = 0;
      const schedule = () => {
        if (disposed) return;
        // Parked by `__dshbgHeadGlass(false)`: nothing to mark, so nothing to measure.
        if (suspended) return;
        // The observer watches the whole document, so it fires for every streamed token.
        // Bailing out here keeps that traffic down to a couple of cheap attribute reads -
        // the measuring pass only runs on a page that could plausibly have the bar.
        if (!root.hasAttribute('data-dshbg-on') && marked === null) return;
        if (timer !== 0) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = 0;
          settle();
        }, 90);
      };

      const observer = new MutationObserver(schedule);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-dshbg-on'],
      });
      schedule();

      return {
        // `paint()` runs on every store commit - dragging a slider commits per frame - and
        // each pass costs a `querySelectorAll` plus a handful of `getBoundingClientRect()`,
        // which forces layout. The debounced entry point is the one `paint()` should use.
        sync: schedule,
        settle,
        dispose() {
          disposed = true;
          if (timer !== 0) clearTimeout(timer);
          observer.disconnect();
          unmark();
          if (window.__dshbgHead === report) delete window.__dshbgHead;
          if (typeof window.__dshbgHeadGlass === 'function') delete window.__dshbgHeadGlass;
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
      const hostPanel = installHostPanelGuard();
      const configHead = installConfigHead();

      let disposed = false;
      let measureToken = 0;
      let measureKey = null;
      let lastCss = null;

      /** The wallpaper boxes live here. Created on demand, gone again the moment it is off. */
      const stackHost = () => {
        let host = document.querySelector(`body > ${STACK_SELECTOR}`);
        if (host === null) {
          host = document.createElement('div');
          host.setAttribute(STACK_ATTRIBUTE, '');
          document.body.appendChild(host);
        }
        return host;
      };

      const paint = () => {
        if (disposed) return;
        const { settings, activeImage, luma, layer } = state;
        const on = backgroundValue(settings, activeImage) !== null;
        const root = document.documentElement;
        if (on) root.setAttribute('data-dshbg-on', '');
        else root.removeAttribute('data-dshbg-on');
        // Replacing a `<style>` element's text replaces every rule in it, which restarts
        // every CSS animation the sheet defines - including the title marquee. `paint()` is
        // called on each store commit, so writing an identical sheet would reset the scroll
        // to the beginning for no reason.
        const next = on ? buildCss(settings, layer, toneOf(luma)) : '';
        if (next !== lastCss) {
          lastCss = next;
          tag.textContent = next;
        }
        // The boxes are reconciled after the sheet so that a box never exists unstyled for a
        // frame. Turning the wallpaper off takes the whole container with it.
        if (on) syncWalls(stackHost(), layer);
        else {
          const stale = document.querySelector(`body > ${STACK_SELECTOR}`);
          if (stale !== null) stale.remove();
        }
        // Turning the wallpaper off also drops the `text-overflow: clip` that the marquee
        // depends on, so the animations have to follow the stylesheet, not the setting.
        marquee.sync();
        // Re-check the composer/menu trade whenever the sheet changes: a menu that stayed
        // open across a settings change still needs the card's blur dropped.
        composerMenu.sync();
        // Same for the "a host panel owns the window" marker: the preview can be closed
        // while a slider is being dragged, and the sheet has to follow it back.
        hostPanel.sync();
        // The settings page's title bar is marked from the DOM, not from the sheet, so a
        // repaint is also the moment to re-measure it.
        configHead.sync();
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
          measureKey = null;
          if (state.luma !== null) commit({ luma: null });
          return;
        }
        // The measurement is a function of the artwork, the dim and the panel mix - not of the
        // blur, and not of the framing. Dragging the picture re-commits on every pointer move,
        // and decoding the poster each time is the one thing that would make that stutter.
        const key = `${settings.mode}|${activeImage === null ? '' : activeImage.src}|${settings.dim}|${surfaceOf(settings)}`;
        if (key === measureKey) return;
        measureKey = key;
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
            stop();
            unsubscribe();
            marquee.dispose();
            composerMenu.dispose();
            hostPanel.dispose();
            configHead.dispose();
            tag.remove();
            const stack = document.querySelector(`body > ${STACK_SELECTOR}`);
            if (stack !== null) stack.remove();
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
/* The sidebar panel's frame. The plugin page gives the form its padding; the main slot does
   not, so without this the form sits against the window edge and cannot scroll. The width
   cap is the same reading measure the plugin page uses - sliders stretched across a
   maximised window are hard to aim. */
.dshbg-panel { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 24px 28px 40px; }
.dshbg-panel > .dshbg { max-width: 900px; }
.dshbg { display: flex; flex-direction: column; gap: 18px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f1115); }
.dshbg-head { display: flex; flex-direction: column; gap: 3px; }
.dshbg-title { font-size: 14px; font-weight: 600; line-height: 20px; margin: 0; }
.dshbg-sub { font-size: 12px; line-height: 17px; margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); }
.dshbg-preview { position: relative; height: 136px; border-radius: 10px; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 12%)); background: var(--dsw-alias-bg-layer-2, #eef0f3); }
.dshbg-preview-art { position: absolute; inset: -28px; background-position: center; background-size: cover; background-repeat: no-repeat; }
.dshbg-preview-art > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; border: 0; }
/* Dragging the preview is how the framing is aimed, so it must not scroll the page on touch
   and it must not select the mock text on the way past. */
.dshbg-preview-grab { cursor: grab; touch-action: none; user-select: none; }
.dshbg-preview-grab:active { cursor: grabbing; }
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
.dshbg-tile-kind { position: absolute; left: 4px; bottom: 4px; padding: 1px 5px; border-radius: 6px; font-size: 10px; line-height: 1.4; color: #fff; background: rgb(0 0 0 / 55%); pointer-events: none; }
.dshbg-add { border: 1px dashed var(--dsw-alias-border-l2, rgb(0 0 0 / 18%)); border-radius: 8px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary, #4b5563); font-size: 12px; aspect-ratio: 16 / 10; }
.dshbg-add:hover { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dsw-alias-label-primary, #0f1115); }
/* An ordinary inline action - sized by its own text, not by a grid cell. .dshbg-add is a
   gallery tile and carries aspect-ratio 16 / 10; sharing it with a normal button is how
   居中 once became a 675px dashed frame. */
.dshbg-plain { align-self: flex-start; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 18%)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgb(0 0 0 / 4%)); padding: 6px 14px; font-size: 12px; line-height: 1.4; cursor: pointer; color: var(--dsw-alias-label-secondary, #4b5563); }
.dshbg-plain:hover { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dsw-alias-label-primary, #0f1115); }
/* The folder scan's own panel. It sits inside the gallery section but reads as a separate
   tray, because it is a temporary answer to "what is in this folder" rather than part of
   the gallery the user is building. */
.dshbg-picks-row { display: flex; align-items: center; gap: 14px; }
.dshbg-picks { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2, rgb(0 0 0 / 4%)); }
.dshbg-pick { padding: 0; cursor: pointer; }
.dshbg-pick-name { display: block; position: absolute; left: 4px; right: 4px; bottom: 4px; padding: 1px 5px; border-radius: 6px; font-size: 10px; line-height: 1.4; color: #fff; background: rgb(0 0 0 / 55%); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; pointer-events: none; }
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
      const dirInput = useRef(null);
      // What a folder scan turned up: the files still worth offering, and how many were left
      // out because the gallery already holds them. `null` means no scan has been run.
      const [browse, setBrowse] = useState(null);
      // The scan's thumbnails are object URLs, and they are borrowed rather than owned. They
      // are released as a batch - on the next scan and on unmount - instead of per tile,
      // because a tile that stays in the list keeps the same URL and revoking it there would
      // blank a thumbnail that is still on screen.
      const browseUrls = useRef([]);

      useEffect(() => {
        boot();
      }, []);

      useEffect(
        () => () => {
          browseUrls.current.forEach((url) => window.URL.revokeObjectURL(url));
          browseUrls.current = [];
        },
        [],
      );

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
        const isVideo = String((file && file.type) || '').indexOf('video/') === 0;
        addImage(file).catch((failure) => {
          const code = failure && failure.message;
          if (code === 'too-large') setError(text.tooLarge);
          else if (code === 'too-large-media') setError(text.tooLargeMedia);
          else if (code === 'duplicate') setError(text.duplicate);
          else if (isVideo && code === 'decode') setError(text.videoFail);
          else setError(text.readFail);
        });
      }, [text.duplicate, text.readFail, text.tooLarge, text.tooLargeMedia, text.videoFail]);

      /**
       * What a folder scan leaves out, and why it can only be a first pass.
       *
       * The gallery cannot be asked "do you already hold this file" by path: a browser never
       * sees a real path, and a `File` does not survive a reload. What does survive is the
       * `name|size|lastModified` triple, recorded on every upload since this feature landed,
       * so a folder that still holds the same file is recognised without decoding a single
       * picture.
       *
       * The gap: a picture added by an older build has no `source`, so it cannot be matched
       * here and will be offered again. `addImage` still refuses it by fingerprint, so the
       * cost is a tile that turns out to be a duplicate when clicked - not a duplicate in the
       * gallery. That is the right way round: offering something twice is an annoyance,
       * silently hiding a picture the user is looking for is not.
       */
      const scanFolder = (fileList) => {
        setError(null);
        browseUrls.current.forEach((url) => window.URL.revokeObjectURL(url));
        browseUrls.current = [];
        const files = Array.from(fileList || []);
        const media = files.filter((file) => /^(image|video)\//.test(String(file.type || '')));
        const known = new Set(
          (images === null ? [] : images)
            .filter((record) => record.source !== undefined && record.source !== null)
            .map((record) => `${record.source.name}|${record.source.size}|${record.source.lastModified}`),
        );
        const fresh = media.filter((file) => !known.has(`${file.name}|${file.size}|${file.lastModified}`));
        const items = fresh.map((file) => ({ file, url: window.URL.createObjectURL(file) }));
        browseUrls.current = items.map((item) => item.url);
        const relative = files.find((file) => String(file.webkitRelativePath || '').indexOf('/') > 0);
        setBrowse({
          dir: relative === undefined ? '' : String(relative.webkitRelativePath).split('/')[0],
          items,
          hidden: media.length - fresh.length,
        });
      };

      const addFromBrowse = (item) => {
        setError(null);
        addImage(item.file)
          .then(() => {
            // The URL is deliberately not revoked here: the same object is about to be gone
            // from the list, but a scan still holds the batch, and revoking one tile in the
            // middle of a batch is how a thumbnail elsewhere goes blank.
            setBrowse((prev) =>
              prev === null ? null : { ...prev, items: prev.items.filter((entry) => entry !== item) },
            );
          })
          .catch((failure) => {
            const code = failure && failure.message;
            if (code === 'duplicate') setError(text.duplicate);
            else if (code === 'too-large') setError(text.tooLarge);
            else if (code === 'too-large-media') setError(text.tooLargeMedia);
            else setError(text.readFail);
          });
      };

      const palette = fontPalette(settings, tone);
      const previewColor = palette === null ? null : palette.primary;
      const previewValue = backgroundValue(settings, activeImage);
      const gallery = images === null ? [] : images;
      const activeRecord = gallery.find((record) => record.id === settings.imageId) || null;
      const sections = [];

      /**
       * Dragging the preview is the whole point of the framing control: the numbers are hard to
       * aim with, and "move that person back into the frame" is a gesture, not a percentage.
       *
       * The mapping is one-to-one, not a fixed sensitivity. With `background-size: cover` the
       * picture is scaled until it covers the box, so the distance it can travel is
       * `scaled - box`, and dragging by exactly that distance has to move it by exactly 100%.
       * The sign is inverted because `X%` aligns X% of the picture with X% of the box - a
       * larger X slides the picture left, which is the opposite of the pointer.
       *
       * An axis with no slack (a tall picture on a wide preview) simply does not move, which is
       * the truth of the situation rather than a dead control.
       */
      const drag = useRef(null);

      const dragStart = useCallback((event) => {
        if (settings.mode !== 'image' || event.button === 2) return;
        const box = event.currentTarget.getBoundingClientRect();
        const width = activeRecord === null ? 0 : activeRecord.width || 0;
        const height = activeRecord === null ? 0 : activeRecord.height || 0;
        let slackX = box.width;
        let slackY = box.height;
        if (width > 0 && height > 0) {
          const scale = Math.max(box.width / width, box.height / height);
          slackX = Math.max(0, width * scale - box.width);
          slackY = Math.max(0, height * scale - box.height);
        }
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          focusX: settings.focusX,
          focusY: settings.focusY,
          slackX,
          slackY,
        };
        if (event.currentTarget.setPointerCapture) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch (failure) {
            /* capture is a nicety; the drag still works without it */
          }
        }
        event.preventDefault();
      }, [settings.mode, settings.focusX, settings.focusY, activeRecord]);

      const dragMove = useCallback((event) => {
        const started = drag.current;
        if (started === null) return;
        const shift = (slack, from, to) =>
          slack === 0 ? from : clamp(from - (to / slack) * 100, 0, 100);
        patchSettings({
          focusX: Math.round(shift(started.slackX, started.focusX, event.clientX - started.x)),
          focusY: Math.round(shift(started.slackY, started.focusY, event.clientY - started.y)),
        });
      }, []);

      const dragEnd = useCallback(() => {
        drag.current = null;
      }, []);

      sections.push(
        h(
          'div',
          { key: 'preview', className: 'dshbg-section' },
          h('div', { className: 'dshbg-label' }, text.preview),
          h(
            'div',
            {
              className: settings.mode === 'image' ? 'dshbg-preview dshbg-preview-grab' : 'dshbg-preview',
              onPointerDown: dragStart,
              onPointerMove: dragMove,
              onPointerUp: dragEnd,
              onPointerCancel: dragEnd,
            },
            h(
              'div',
              {
                className: 'dshbg-preview-art',
                style: {
                  backgroundImage: previewValue === null ? 'none' : previewValue.css,
                  backgroundPosition: `${settings.focusX}% ${settings.focusY}%`,
                  filter: `blur(${Math.round(settings.blur / 2)}px)`,
                },
              },
              activeRecord !== null && kindOf(activeRecord) === 'video'
                ? h('video', {
                    src: mediaUrlOf(activeRecord),
                    muted: true,
                    loop: true,
                    autoPlay: true,
                    playsInline: true,
                    style: { objectPosition: `${settings.focusX}% ${settings.focusY}%` },
                  })
                : null,
            ),
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
                    'data-kind': kindOf(record),
                    // A clip has no `dataUrl`; its poster frame is what the tile shows. That is
                    // also why the poster exists - the gallery, the preview and the luminance
                    // probe all read one still image instead of decoding a video three times.
                    style: { backgroundImage: `url("${record.poster || record.dataUrl || ''}")` },
                    onClick: () => patchSettings({ imageId: record.id }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        patchSettings({ imageId: record.id });
                      }
                    },
                  },
                  kindOf(record) === 'video' || kindOf(record) === 'animated'
                    ? h(
                        'span',
                        { className: 'dshbg-tile-kind' },
                        kindOf(record) === 'video' ? text.kindVideo : text.kindAnimated,
                      )
                    : null,
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
            h(
              'input',
              {
                // React has no first-class prop for this one, and passing an unknown one
                // through JSX is how it gets silently dropped by some versions. Setting the
                // attribute on the node is what actually turns the picker into a folder
                // picker. `directory` is the Firefox spelling, kept so the markup says what
                // it means.
                ref: (node) => {
                  dirInput.current = node;
                  if (node !== null && !node.hasAttribute('webkitdirectory')) {
                    node.setAttribute('webkitdirectory', '');
                    node.setAttribute('directory', '');
                  }
                },
                type: 'file',
                multiple: true,
                style: { display: 'none' },
                onChange: (event) => {
                  scanFolder(event.target.files);
                  event.target.value = '';
                },
              },
            ),
            h(
              'div',
              { className: 'dshbg-picks-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshbg-link',
                  onClick: () => dirInput.current && dirInput.current.click(),
                },
                text.browse,
              ),
              browse === null
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshbg-link',
                      onClick: () => {
                        setBrowse(null);
                        browseUrls.current.forEach((url) => window.URL.revokeObjectURL(url));
                        browseUrls.current = [];
                      },
                    },
                    text.browseClose,
                  ),
            ),
            browse === null
              ? null
              : h(
                  'div',
                  { className: 'dshbg-picks' },
                  h('div', { className: 'dshbg-label' }, browse.dir),
                  browse.items.length === 0
                    ? h('p', { className: 'dshbg-hint' }, text.browseEmpty)
                    : h(
                        'div',
                        { className: 'dshbg-grid' },
                        ...browse.items.map((item) =>
                          h(
                            'button',
                            {
                              key: `${item.file.name}|${item.file.size}|${item.file.lastModified}`,
                              type: 'button',
                              className: 'dshbg-tile dshbg-pick',
                              title: item.file.name,
                              style: { backgroundImage: `url("${item.url}")` },
                              onClick: () => addFromBrowse(item),
                            },
                            h('span', { className: 'dshbg-pick-name' }, item.file.name),
                          ),
                        ),
                      ),
                  browse.hidden === 0
                    ? null
                    : h('p', { className: 'dshbg-hint' }, `${browse.hidden} ${text.browseHidden}`),
                  h('p', { className: 'dshbg-hint' }, text.browseHint),
                ),
            h('p', { className: 'dshbg-hint' }, text.galleryHint),
          ),
        );

        if (activeRecord !== null) {
          sections.push(
            h(
              'div',
              { key: 'framing', className: 'dshbg-section', style: { gap: '10px' } },
              h('div', { className: 'dshbg-label' }, text.framing),
              h(Slider, {
                label: text.focusX,
                value: settings.focusX,
                min: 0,
                max: 100,
                step: 1,
                suffix: '%',
                onChange: (value) => patchSettings({ focusX: value }),
              }),
              h(Slider, {
                label: text.focusY,
                value: settings.focusY,
                min: 0,
                max: 100,
                step: 1,
                suffix: '%',
                onChange: (value) => patchSettings({ focusY: value }),
              }),
              h(
                'button',
                {
                  type: 'button',
                  // ⚠️ Not `dshbg-add`. That class carries `aspect-ratio: 16 / 10` because it
                  // is a *tile* in the gallery grid; reused here it stretched this button to
                  // a 675px-tall dashed box around the word 居中.
                  className: 'dshbg-plain',
                  onClick: () => patchSettings({ focusX: DEFAULTS.focusX, focusY: DEFAULTS.focusY }),
                },
                text.recenter,
              ),
              h('p', { className: 'dshbg-hint' }, text.framingHint),
            ),
          );
        }
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
            accept: 'image/*,video/*',
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

    /**
     * The sidebar glyph.
     *
     * Drawn inline rather than taken from `ui-primitives`: an icon font import would add a
     * second injected module for one 16px shape, and the sidebar hands the component only
     * `size`, so a plain `<svg>` sized from that prop is the whole contract. `currentColor`
     * is what makes it follow the rail's own selected/unselected tint.
     */
    function WallpaperIcon({ size }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('rect', { x: 1.7, y: 2.7, width: 12.6, height: 10.6, rx: 2.4 }),
        h('circle', { cx: 5.6, cy: 6.5, r: 1.35 }),
        h('path', { d: 'M2.3 12.1l3.5-3.3 2.5 2.3 2.2-1.9 3.2 2.9' }),
      );
    }

    /**
     * The sidebar panel wrapper.
     *
     * `ConfigPage` carries no padding of its own - in the plugin detail page the host
     * supplies it. Dropped straight into `main` the form would sit flush against the window
     * edge, so this wrapper is what supplies the frame and the scroll. It is a separate
     * component rather than a rule on `.dshbg` because that same `.dshbg` also renders in
     * the plugin page, where padding here would stack on top of the host's.
     */
    function WallpaperPanel(props) {
      return h('div', { className: 'dshbg-panel' }, h(ConfigPage, props));
    }

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
              { name: 'plugins.bundle.config', key: PACKAGE, id: PANEL_ID, order: 10 },
              ConfigPage,
            ),
          );
        } catch (failure) {
          console.error('[dsh-custom-background] config slot registration failed:', failure);
        }

        // The sidebar entry. Same component as the plugin page - the panel *is* the config
        // page, so there is one form to maintain and no second copy to drift.
        //
        // ⚠️ **These two registrations are one feature and must stay together.** The host
        // keeps an icon in `sidebar.panellist` and, when it is clicked, looks the panel up
        // in the root-scoped `main` keyed slot **by the same id**. A missing `main` entry
        // does not render an empty page: `selectPanel` throws and the current selection is
        // kept, so the symptom is an icon that does nothing at all, with nothing in the UI
        // to say why. Registering only the icon is therefore worse than registering
        // neither.
        //
        // `view: 'page'` is what the component checks before it sets `data-dshbg-config`,
        // and that attribute is what lets the page be transparent so the wallpaper stays
        // visible while it is being adjusted. Handing it anything else here would paint an
        // opaque sheet over the very thing the sliders change.
        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ view: 'page' }) }, WallpaperPanel),
          );
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                // After the host's own entries (plugins is 0), so the icon lands at the
                // bottom of the list rather than pushing the built-ins down.
                order: 20,
                label: () => (currentLang() === 'zh' ? '壁纸' : 'Wallpaper'),
              },
              WallpaperIcon,
            ),
          );
        } catch (failure) {
          console.error('[dsh-custom-background] sidebar entry registration failed:', failure);
        }

      },
    };
  },
});
