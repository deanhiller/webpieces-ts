#!/usr/bin/env node
// Postinstall shim — delegates to compiled TypeScript.
// Must be plain JS because it runs during `pnpm install` BEFORE any build step.
//
// In workspace: compiled .js doesn't exist yet → silently exits (no-op).
// In consumer:  compiled .js exists in npm package → runs full setup.
'use strict';

const path = require('path');
const fs = require('fs');

const compiled = path.join(__dirname, '..', 'src', 'bin', 'postinstall.js');
if (fs.existsSync(compiled)) {
    require(compiled).main().catch(function (err) {
        console.error('  [ai-hook-rules] postinstall warning:', err.message);
    });
}
