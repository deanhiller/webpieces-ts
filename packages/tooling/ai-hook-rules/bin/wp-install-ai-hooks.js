#!/usr/bin/env node
// Plain JS shim — delegates to compiled TypeScript.
// Must NOT be converted to TypeScript (needs to exist pre-build for pnpm bin symlinks).
//
// Points at install-entry.js, NOT setup.js, on purpose. setup.js top-level-imports
// @webpieces/rules-config -> minimatch, so on a CORRUPT node_modules (a package half-written by an
// install that was killed mid-copy) node died at require() time with a raw MODULE_NOT_FOUND loader
// trace — before the installer could rewrite the fail-closed shim, which is the one thing that would
// have made the breakage visible. install-entry.js imports only ./shim (fs + path), re-arms the shim
// first, and only then loads setup.js lazily. See install-entry.ts for the full story.
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions
'use strict';

const path = require('path');
const fs = require('fs');
const compiled = path.join(__dirname, '..', 'src', 'bin', 'install-entry.js');

if (fs.existsSync(compiled)) {
    require(compiled).runInstaller(process.cwd()).then((code) => process.exit(code));
} else {
    console.error('  [ai-hook-rules] Package not built yet. Run the build first, or install from npm.');
    process.exit(1);
}
