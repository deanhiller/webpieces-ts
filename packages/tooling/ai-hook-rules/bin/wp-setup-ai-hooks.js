#!/usr/bin/env node
// Plain JS shim — delegates to compiled TypeScript.
// Must NOT be converted to TypeScript (needs to exist pre-build for pnpm bin symlinks).
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions
'use strict';

const path = require('path');
const fs = require('fs');
const compiled = path.join(__dirname, '..', 'src', 'bin', 'postinstall.js');

if (fs.existsSync(compiled)) {
    require(compiled).main().catch(function (err) {
        console.error('  [ai-hook-rules] error:', err.message);
        process.exit(1);
    });
} else {
    console.error('  [ai-hook-rules] Package not built yet. Run the build first, or install from npm.');
    process.exit(1);
}
