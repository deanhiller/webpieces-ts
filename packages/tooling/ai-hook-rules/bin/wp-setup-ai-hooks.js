#!/usr/bin/env node
// Plain JS shim — delegates to compiled TypeScript.
// Must NOT be converted to TypeScript (needs to exist pre-build for pnpm bin symlinks).
'use strict';

const path = require('path');
const compiled = path.join(__dirname, '..', 'src', 'bin', 'postinstall.js');

try {
    require(compiled).main().catch(function (err) {
        console.error('  [ai-hook-rules] error:', err.message);
        process.exit(1);
    });
} catch (e) {
    console.error('  [ai-hook-rules] Package not built yet. Run the build first, or install from npm.');
    process.exit(1);
}
