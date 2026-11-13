#!/usr/bin/env node
/**
 * Manual door to the `dsh-cost-meter` glass patch.
 *
 * The implementation is `../cost-meter-patch.js` - the same function the plugin calls on
 * boot, so there is exactly one definition of what "patched" means and one place to fix it
 * when the cost meter changes shape. Since the plugin repairs itself on launch this script
 * is for doing it without a restart, and for undoing it.
 *
 *   node tools/patch-cost-meter.cjs          # apply now, and re-enable auto repair
 *   node tools/patch-cost-meter.cjs --revert # restore the original and stop auto repair
 */
const path = require('path');
const { pathToFileURL } = require('url');

const MESSAGES = {
  patched: (r) => `patched ${r.target}`,
  already: (r) => `already patched ${r.target}`,
  restored: (r) => `restored ${r.target}\nauto repair is now off - delete ${r.target}.dshbg-off to turn it back on`,
  off: (r) => `auto repair is off for ${r.target}`,
  missing: (r) => `not found: ${r.target}`,
  'anchor-missing': (r) =>
    `anchor rule not found in ${r.target}\nthe plugin probably changed - re-derive MARKER in cost-meter-patch.js`,
  'no-backup': (r) => `no backup at ${r.target}.dshbg-orig`,
  error: (r) => `could not write ${r.target}: ${r.error}`,
};

const BAD = new Set(['missing', 'anchor-missing', 'no-backup', 'error']);

async function main() {
  const module = await import(pathToFileURL(path.join(__dirname, '..', 'cost-meter-patch.js')).href);
  const reverted = process.argv.includes('--revert');
  // `force` on purpose: running this by hand is the documented way to turn auto repair back
  // on, and an off-marker that silently smothered the command would be a trap.
  const result = reverted ? module.revert() : module.apply({ force: true });
  const line = MESSAGES[result.status] ? MESSAGES[result.status](result) : `unexpected status: ${result.status}`;
  (BAD.has(result.status) ? console.error : console.log)(line);
  process.exit(BAD.has(result.status) ? 1 : 0);
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});
