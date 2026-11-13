#!/usr/bin/env node
/**
 * Independent entry point for the `dsh-cost-meter` glass patch - the login hook.
 *
 * `index.js` already applies the patch when the host assembles the bundle, and
 * `watchForWipe` repairs it while the app is running. Both of those depend on the host half
 * actually being assembled, which is not something this side can check from the outside - and
 * on 2026-11-14 a live probe showed the watcher had not been running while an offline call to
 * the same function repaired the file in 400ms. So there is a third entrance that owes nothing
 * to DSH: it runs at login and is idempotent.
 *
 * Why a login hook and not a resident daemon: the patch is a string spliced into a file that
 * the *browser* reads when it loads. Writing it later cannot repaint an already-open window,
 * so the only moment that matters is "before the next launch". A one-shot process costs ~60ms;
 * a watcher would cost ~40MB of RSS forever to cover a case a restart fixes anyway.
 *
 * Registered as `HKCU\...\Run\DSHBG-CostMeterHeal`:
 *
 *   "C:\Users\<user>\.codearts\runtimes\node\node.exe" \
 *     "D:\dsh-plugins\custom-background\tools\cost-meter-heal.mjs" --quiet
 *
 *   node tools/cost-meter-heal.mjs            # apply if needed, say what happened
 *   node tools/cost-meter-heal.mjs --quiet    # only speak when something actually changed
 *   node tools/cost-meter-heal.mjs --revert   # restore the original, stop auto repair
 *
 * Exit codes: 0 fine (including "nothing to do"), 1 the patch could not be applied.
 */
const patcher = await import(new URL('../cost-meter-patch.js', import.meta.url).href);

const quiet = process.argv.includes('--quiet');
const revert = process.argv.includes('--revert');

// `force` on purpose: a login hook that honoured an `.dshbg-off` marker would make `--revert`
// permanent by accident, and the documented way to undo a revert is to just run this again.
const result = revert ? patcher.revert() : patcher.apply({ force: true });

/**
 * `missing` is not a failure: cost-meter may simply not be installed in this profile, and a
 * login hook that reports errors over an absent optional plugin teaches people to ignore its
 * exit code.
 */
const FAILED = new Set(['anchor-missing', 'no-backup', 'error']);
const changed = result.status === 'patched' || result.status === 'restored';

const line =
  {
    patched: `login hook re-applied to ${result.target}`,
    already: `login hook: already patched ${result.target}`,
    restored: `login hook restored ${result.target} - auto repair is off until this runs again`,
    off: `auto repair is off for ${result.target}`,
    missing: `not installed: ${result.target}`,
    'anchor-missing': `anchor not found in ${result.target} - cost-meter changed shape, re-derive MARKER`,
    'no-backup': `no backup at ${result.target}.dshbg-orig`,
    error: `could not write ${result.target}: ${result.error}`,
  }[result.status] ?? `unexpected status: ${result.status}`;

// `already` is the normal outcome on ~every login; saying so would drown the trail.
if (changed || FAILED.has(result.status) || !quiet) {
  patcher.logLine(line);
  // Only a human running this by hand wants it on stdout; the login hook is silent.
  if (!quiet) console.log(line);
}
process.exit(FAILED.has(result.status) ? 1 : 0);
