#!/usr/bin/env node
// Plain JS shim — delegates to compiled TypeScript.
// Must NOT be converted to TypeScript (needs to exist pre-build for pnpm bin symlinks).
'use strict';

const path = require('path');
const compiled = path.join(__dirname, '..', 'src', 'cli.js');

try {
    require(compiled);
} catch (e) {
    console.error('  [code-rules] Package not built yet. Run the build first, or install from npm.');
    process.exit(1);
}
