/**
 * The `dsh-cost-meter` glass patch, as one implementation shared by two callers.
 *
 * `index.js` calls `apply()` once when the host assembles the plugin, so a cost-meter
 * upgrade that wipes the patch is repaired on the next launch instead of waiting for
 * someone to notice the dialog turned back into a dark slab. `tools/patch-cost-meter.cjs`
 * is the manual door to the same functions.
 *
 * Why the patch has to live in that plugin's own file at all: its dialog is painted by
 *
 *   background: rgb(from var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)) r g b / 1);
 *
 * The trailing `/ 1` re-imposes full opacity, so any transparency put into the token is
 * discarded before it reaches the screen. Nothing injected from our side can win that -
 * the rule is in the plugin's own stylesheet, nearer the host than any sheet of ours - so
 * the rule itself is what gets amended.
 *
 * The bundle is minified and token-compressed: `!important`, token names and whole
 * declarations are single glyphs from `ƀ`–`ǿ`. Appending plain ASCII is safe (the decoder
 * only substitutes those glyphs), and appending right after the offending rule wins the
 * cascade.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Pristine copy of the file as it was before the first patch. */
export const BACKUP_SUFFIX = '.dshbg-orig';
/** Present = auto-repair disabled (`--revert` leaves it behind on purpose). */
export const OFF_SUFFIX = '.dshbg-off';

/** The tail of the offending declaration. Patch goes immediately after it. */
export const MARKER = 'bg-base,#fff)) r g b / 1)}';

/** Idempotency probe. If this is in the file the patch is already in. */
export const SIGNATURE = 'color-mix(in srgb,#ffffff 14%,transparent)';

/**
 * A light frosted tint rather than a dark one: over a dimmed wallpaper any dark fill still
 * reads as a black slab, while white at ~14% reads as glass no matter what is behind it.
 *
 * ⚠️ No quote characters, no backslashes. The CSS is spliced into the middle of a string
 * literal in the minified bundle - a stray `"` there is a syntax error and the whole
 * plugin disappears from the UI, not just its dialog.
 */
export const PATCH = [
  'body :is(.cm-stat-dialog,.cm-qguide,.cm-peak-alert),body dialog.cm-fee-dialog{',
  'background:color-mix(in srgb,#ffffff 14%,transparent)!important;',
  '-webkit-backdrop-filter:blur(46px) saturate(150%)!important;',
  'backdrop-filter:blur(46px) saturate(150%)!important;',
  'box-shadow:0 28px 90px -34px #000000cc,inset 0 0 0 1px #ffffff24!important;',
  '--cm-opaque-base:transparent}',
  'body .cm-stat{background:transparent!important}',
  'body .cm-stat-dialog::backdrop,body .cm-stat::backdrop{background:#080a0e59!important}',
].join('');

/**
 * Where the installed bundle is. Read at call time, not at module load: the tests point this
 * at a scratch file, and `DSHBG_COST_METER` is the escape hatch for a non-standard profile.
 */
export function defaultTarget() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return (
    process.env.DSHBG_COST_METER ||
    path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-cost-meter', 'lib', 'client.js')
  );
}

/**
 * Make the dialog glass. Never throws - the caller is the plugin's `apply()`, and a cosmetic
 * patch that throws there would take the whole plugin down with it.
 *
 * @returns {{status: string, target: string, error?: unknown}}
 *   `patched` | `already` | `missing` | `anchor-missing` | `off` | `error`
 */
export function apply(options = {}) {
  const target = options.target || defaultTarget();
  const force = options.force === true;

  // Two ways to opt out, both checked before the file is even read. A `--revert` that the
  // next launch silently undoes would not be a revert, it would be a shrug.
  if (!force && process.env.DSHBG_NO_CM_PATCH) return { status: 'off', target };
  if (!force && fs.existsSync(target + OFF_SUFFIX)) return { status: 'off', target };

  let source;
  try {
    source = fs.readFileSync(target, 'utf8');
  } catch {
    // Not installed, or unreadable. Either way there is nothing to do and nothing to say.
    return { status: 'missing', target };
  }

  if (source.includes(SIGNATURE)) return { status: 'already', target };

  const at = source.indexOf(MARKER);
  if (at < 0) {
    // The plugin changed shape. Report it instead of guessing at a new anchor: a blind
    // splice into a minified bundle is how you turn a cosmetic bug into a broken plugin.
    return { status: 'anchor-missing', target };
  }

  const cut = at + MARKER.length;
  try {
    if (!fs.existsSync(target + BACKUP_SUFFIX)) {
      fs.writeFileSync(target + BACKUP_SUFFIX, source, 'utf8');
    }
    fs.writeFileSync(target, source.slice(0, cut) + PATCH + source.slice(cut), 'utf8');
  } catch (error) {
    // Typically EBUSY while the app is mid-read. Next launch tries again.
    return { status: 'error', target, error };
  }

  if (fs.existsSync(target + OFF_SUFFIX)) fs.rmSync(target + OFF_SUFFIX, { force: true });
  return { status: 'patched', target };
}

/**
 * Repair the patch whenever the file changes underneath us.
 *
 * A launch-time check only covers upgrades that happen while the app is closed. A cost-meter
 * upgrade installed *while the app is running* rewrote `lib/client.js` at 01:46 and the
 * dialog was a dark slab again until the next restart - which is exactly what the user hit
 * ("这个更新了，又没了"). Watching the directory and repairing on change makes the window
 * between "someone upgraded it" and "it is glass again" a few hundred milliseconds.
 *
 * The *directory* is what gets watched, not the file: an install replaces the file (rename),
 * and a handle on the old inode stops reporting. `filename` is filtered so the sibling
 * `.dshbg-orig` / `.dshbg-off` writes this module makes do not look like upgrades.
 *
 * @returns {{close: () => void} | null} null when there is nothing to watch (not installed,
 *   or the runtime has no usable watcher). Never throws.
 */
export function watchForWipe(options = {}, onChange = () => {}) {
  const target = options.target || defaultTarget();
  const directory = path.dirname(target);
  const base = path.basename(target);
  let timer = null;
  let watcher = null;

  try {
    if (!fs.existsSync(directory)) return null;
    watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== base) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          onChange(apply({ target }));
        } catch {
          // A timer callback that throws is an unhandled exception in the host's main
          // process. There is no cosmetic patch worth that.
        }
      }, 400);
      if (typeof timer.unref === 'function') timer.unref();
    });
    if (typeof watcher.unref === 'function') watcher.unref();
  } catch {
    return null;
  }

  return {
    close() {
      try {
        if (timer) clearTimeout(timer);
        watcher.close();
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Put the pristine file back and leave the `.dshbg-off` marker so the next launch does not
 * re-apply it. The backup is deliberately kept: deleting it would let a later `apply()`
 * snapshot the *patched* text as the original, and there would be no way back.
 */
export function revert(options = {}) {
  const target = options.target || defaultTarget();
  const backup = target + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { status: 'no-backup', target };
  try {
    fs.writeFileSync(target, fs.readFileSync(backup, 'utf8'), 'utf8');
    fs.writeFileSync(
      target + OFF_SUFFIX,
      'dsh-private-background: automatic cost-meter patching is off.\nDelete this file (or run tools/patch-cost-meter.cjs) to turn it back on.\n',
      'utf8',
    );
  } catch (error) {
    return { status: 'error', target, error };
  }
  return { status: 'restored', target };
}
