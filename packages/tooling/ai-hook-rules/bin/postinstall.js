#!/usr/bin/env node
// Thin shim that delegates to the compiled TypeScript postinstall.
// This file must be plain JS because it runs during `pnpm install`
// BEFORE any build step (especially in workspaces).
//
// In workspace: the compiled .js doesn't exist yet, so we silently exit.
// In consumer:  the compiled .js exists in the npm package, so we run it.
'use strict';

const path = require('path');
const fs = require('fs');

const compiled = path.join(__dirname, '..', 'src', 'bin', 'postinstall.js');
if (fs.existsSync(compiled)) {
    require(compiled).main().catch(function (err) {
        console.error('  [ai-hook-rules] postinstall warning:', err.message);
    });
}
