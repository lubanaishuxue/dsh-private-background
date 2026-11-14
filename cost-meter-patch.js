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

/**
 * How often the repair side re-checks the file's fingerprint without an event.
 *
 * 30s is chosen against what the user actually sees: a wiped patch cannot repaint an open
 * window, so a fix only helps once something reloads the bundle. Half a minute keeps "loaded
 * again" close enough to "it happened" that a plain refresh of the window is enough, while a
 * `stat()` every 30 seconds is invisible next to anything else the host does.
 */
export const DEFAULT_POLL_MS = 30_000;

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
 * Append one line to `$DSH_HOME/dshbg-cost-meter-heal.log`.
 *
 * Three different moments can touch this patch - assembly, the file watcher, and the login
 * hook - and two of them have no console anyone ever looks at. A small append-only trail is
 * the only way to answer "did this launch repair anything?" after the fact. Rolls over at
 * 512 KB so a stuck condition cannot fill the disk.
 *
 * Never throws: a log that cannot be written must not affect the outcome it is describing.
 */
export function logLine(line) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  // `DSHBG_LOG_FILE` keeps the test run out of the user's real trail.
  const file = process.env.DSHBG_LOG_FILE || path.join(home, '.dsh', 'dshbg-cost-meter-heal.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* nothing to do and nowhere to say it */
  }
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
 * ⚠️ An install does not swap the file in one step: the directory is torn down and rebuilt, so
 * a change event routinely lands *inside* the gap where `client.js` does not exist yet. The
 * handler used to call `apply()` once, get `missing`, and give up forever - which is exactly
 * how 1.9.64 → 1.9.65 lost the patch at 23:26 on 2026-11-14, leaving `watcher missing` as the
 * only trace. Two things fix it: `missing` is retried with backoff, and a slow fingerprint
 * poll backs the watcher up for the case where the event never fires at all.
 *
 * @param {object} [options]
 * @param {number} [options.pollMs] fingerprint interval; `0` disables the poll (tests).
 * @returns {{close: () => void} | null} null when there is nothing to watch (not installed,
 *   or the runtime has no usable watcher). Never throws.
 */
export function watchForWipe(options = {}, onChange = () => {}) {
  const target = options.target || defaultTarget();
  const directory = path.dirname(target);
  const base = path.basename(target);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  /** Identity of the installed file, or `''` while it is absent mid-install. */
  function fingerprint() {
    try {
      const stat = fs.statSync(target);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return '';
    }
  }

  let timer = null;
  let watcher = null;
  let poller = null;
  let closed = false;
  let seen = fingerprint();

  function later(delay, fn) {
    const handle = setTimeout(() => {
      timer = null;
      fn();
    }, delay);
    if (typeof handle.unref === 'function') handle.unref();
    return handle;
  }

  function report(result) {
    try {
      onChange(result);
    } catch {
      // A timer callback that throws is an unhandled exception in the host's main process.
      // There is no cosmetic patch worth that.
    }
  }

  /**
   * Apply, and if the package is mid-replacement, come back for it. The delays cover the
   * whole window a pnpm install can leave the file absent (~7s total); they are not an
   * arbitrary number of tries, they are the install's own duration.
   */
  const RETRY = [320, 640, 1200, 2000, 3000];

  function settle(attempt) {
    if (closed) return;
    let result;
    try {
      result = apply({ target });
    } catch (error) {
      report({ status: 'error', target, error });
      return;
    }
    if (result.status === 'missing' && attempt < RETRY.length) {
      timer = later(RETRY[attempt], () => settle(attempt + 1));
      return;
    }
    seen = fingerprint();
    // `missing` after every retry means the plugin is genuinely gone (uninstalled, or the
    // profile is being rebuilt); there is nothing to report to a user who cannot act on it.
    if (result.status !== 'missing') report(result);
  }

  try {
    if (!fs.existsSync(directory)) return null;
    watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== base) return;
      if (timer) clearTimeout(timer);
      timer = later(400, () => settle(0));
    });
    if (typeof watcher.unref === 'function') watcher.unref();
  } catch {
    return null;
  }

  // The watcher fires on the *directory*, and Windows coalesces those events while the
  // antivirus scans a fresh install. A cheap stat on a slow loop costs nothing and covers the
  // case where no event arrives at all - the one case that used to need a human.
  if (pollMs > 0) {
    poller = setInterval(() => {
      if (closed) return;
      if (fingerprint() !== seen && !timer) settle(0);
    }, pollMs);
    if (typeof poller.unref === 'function') poller.unref();
  }

  return {
    close() {
      closed = true;
      try {
        if (timer) clearTimeout(timer);
        if (poller) clearInterval(poller);
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
