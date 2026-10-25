#!/usr/bin/env node
/**
 * Patch the installed `dsh-cost-meter` so its statistics dialog becomes glass.
 *
 * Why this exists outside the plugin: that dialog is a portaled
 * `<dialog class="cm-stat-dialog">` whose own rule is
 *
 *   background: var(--cm-opaque-base, #fff);
 *   background: rgb(from var(--dsw-alias-bg-layer-2, …) r g b / 1);
 *
 * The `/ 1` forces full opacity, so nothing the background plugin does to the tokens can
 * reach it - and it is painted *after* every sheet we inject. Three rounds of fighting it
 * from the outside (retargeting the classes, then inline `!important` from JS) left the
 * dialog dark, so the fix lives in the plugin's own stylesheet instead.
 *
 * The bundle is minified and token-compressed: its CSS literal replaces `!important`,
 * token names and whole declarations with single glyphs from `ƀ`–`ǿ`. Appending plain ASCII
 * CSS is safe - the decoder only substitutes those glyphs - and appending it right after the
 * offending rule wins the cascade.
 *
 *   node tools/patch-cost-meter.cjs          # apply (idempotent)
 *   node tools/patch-cost-meter.cjs --revert # restore the backup
 */
const fs = require('fs');
const path = require('path');

const TARGET =
  process.env.DSHBG_COST_METER ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.dsh/profiles/desktop/node_modules/dsh-cost-meter/lib/client.js',
  );
const BACKUP = `${TARGET}.dshbg-orig`;
const MARKER = 'bg-base,#fff)) r g b / 1)}';
const SIGNATURE = 'color-mix(in srgb,#ffffff 14%,transparent)';

// A light frosted tint rather than a dark one: over a dimmed wallpaper any dark fill still
// reads as a black slab, while white at ~14% reads as glass no matter what is behind it.
const PATCH = [
  'body :is(.cm-stat-dialog,.cm-qguide,.cm-peak-alert),body dialog.cm-fee-dialog{',
  'background:color-mix(in srgb,#ffffff 14%,transparent)!important;',
  '-webkit-backdrop-filter:blur(46px) saturate(150%)!important;',
  'backdrop-filter:blur(46px) saturate(150%)!important;',
  'box-shadow:0 28px 90px -34px #000000cc,inset 0 0 0 1px #ffffff24!important;',
  '--cm-opaque-base:transparent}',
  'body .cm-stat{background:transparent!important}',
  'body .cm-stat-dialog::backdrop,body .cm-stat::backdrop{background:#080a0e59!important}',
].join('');

function main() {
  const revert = process.argv.includes('--revert');
  if (!fs.existsSync(TARGET)) {
    console.error(`not found: ${TARGET}`);
    process.exit(1);
  }
  const source = fs.readFileSync(TARGET, 'utf8');

  if (revert) {
    if (!fs.existsSync(BACKUP)) {
      console.error(`no backup at ${BACKUP}`);
      process.exit(1);
    }
    fs.writeFileSync(TARGET, fs.readFileSync(BACKUP, 'utf8'), 'utf8');
    console.log(`restored ${TARGET}`);
    return;
  }

  if (source.includes(SIGNATURE)) {
    console.log('already patched');
    return;
  }
  const at = source.indexOf(MARKER);
  if (at < 0) {
    console.error('anchor rule not found - the plugin probably changed; re-derive the marker');
    process.exit(1);
  }
  const cut = at + MARKER.length;
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, source, 'utf8');
  fs.writeFileSync(TARGET, source.slice(0, cut) + PATCH + source.slice(cut), 'utf8');
  console.log(`patched ${TARGET} (+${PATCH.length} bytes), backup at ${BACKUP}`);
}

main();
