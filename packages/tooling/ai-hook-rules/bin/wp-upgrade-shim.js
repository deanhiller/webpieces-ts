#!/usr/bin/env node
// Plain JS shim — delegates to compiled TypeScript.
// Must NOT be converted to TypeScript (needs to exist pre-build for pnpm bin symlinks).
//
// Points at upgrade-shim.js, which imports only ./shim (fs + path) + toError — no rule engine — so it
// stays runnable on a tree too broken to load setup.js. It is the CURE allowed through the committed
// shim's self-guard: it rewrites .claude/webpieces/ai-hook.sh from renderShim() (the single source of
// truth) when that committed file was reverted or hand-edited. See upgrade-shim.ts for the full story.
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions
'use strict';

const path = require('path');
const fs = require('fs');
const compiled = path.join(__dirname, '..', 'src', 'bin', 'upgrade-shim.js');

if (fs.existsSync(compiled)) {
    process.exit(require(compiled).runUpgradeShim(process.cwd()));
} else {
    console.error('  [ai-hook-rules] Package not built yet. Run the build first, or install from npm.');
    process.exit(1);
}
