/**
 * Host half of the custom-background bundle.
 *
 * The feature itself is entirely a browser-side surface: it paints a wallpaper behind the
 * shell columns and renders its control panel into `shell.overlay`. Nothing here reaches the
 * model, the session log, or any host service.
 *
 * `apply` exists for exactly one thing: **keeping the `dsh-cost-meter` glass patch alive.**
 * That dialog is painted by the plugin's own stylesheet with `/ 1` on the alpha channel, so
 * it cannot be reached from our sheet and the recipe lives inside its file instead - which
 * means every cost-meter upgrade silently wipes it and the dialog goes back to being a dark
 * slab. Two moments are covered:
 *
 *   - assembly (this function), so a wipe that happened while the app was closed is repaired
 *     before the window ever asks for that bundle;
 *   - any later change to the file, via `watchForWipe`, because cost-meter can also be
 *     upgraded while the app is running - that is not hypothetical, it is what happened at
 *     01:46 on 2026-11-11 (1.9.58 -> 1.9.64).
 */
import { apply as healCostMeter, logLine, watchForWipe } from './cost-meter-patch.js';

/**
 * Cordis reads `name` when it registers a patch-inserted plugin. Without it the host half is
 * anonymous, and an anonymous plugin that throws during assembly is not distinguishable from
 * one that was never loaded - which is exactly the state that left the patch un-repaired on a
 * live launch while the offline probe worked. Keeping the name identical to the package name
 * is what `dsh-pnl` does, and it makes the log line self-identifying.
 */
export const name = 'dsh-private-background';

/** One watcher per process, however many times the host assembles us. */
let watcher = null;

function repair(ctx, { quiet = false } = {}) {
  try {
    const result = healCostMeter();
    // One line per launch, whatever the outcome: it is the only evidence that this code ran
    // at all, and the reason the next "the patch went missing again" report can be answered
    // without guessing.
    logLine(`assembly ${result.status} ${result.target}`);
    if (result.status === 'patched') {
      // Worth one line: it means an upgrade happened, and it explains why the file's own
      // mtime moved. Everything else is either expected (`already`) or nothing to do.
      ctx?.logger?.info?.(`[dshbg] re-applied the cost-meter glass patch: ${result.target}`);
    } else if (result.status === 'anchor-missing' && !quiet) {
      ctx?.logger?.warn?.(
        `[dshbg] cost-meter changed shape, glass patch not applied - re-derive the marker in cost-meter-patch.js (${result.target})`,
      );
    } else if (result.status === 'error' && !quiet) {
      ctx?.logger?.warn?.(`[dshbg] cost-meter glass patch could not be written: ${result.error}`);
    }
    return result.status;
  } catch (error) {
    // A cosmetic patch must never be the reason a plugin fails to assemble.
    ctx?.logger?.warn?.(`[dshbg] cost-meter glass patch threw: ${error}`);
    return 'error';
  }
}

export function apply(ctx) {
  repair(ctx);
  if (watcher) return;
  watcher = watchForWipe({}, (result) => {
    try {
      logLine(`watcher ${result.status} ${result.target}`);
      if (result.status === 'patched') {
        ctx?.logger?.info?.('[dshbg] cost-meter was upgraded while running - glass patch re-applied');
      } else if (result.status === 'anchor-missing') {
        ctx?.logger?.warn?.(
          `[dshbg] cost-meter changed shape, glass patch not applied - re-derive the marker in cost-meter-patch.js (${result.target})`,
        );
      }
    } catch {
      // Logging is the last thing that may throw here.
    }
  });
  // A missing watcher is not fatal - the login hook covers a wipe that happens while the app
  // is closed - but it must be visible, or the next report of "it went missing again" reads
  // as if the watcher had been running all along.
  if (!watcher) logLine('watcher unavailable - the login hook is the only guard');
}
