#!/usr/bin/env node
// Plain JS shim -> delegates to the compiled TypeScript entry point.
//
// Must NOT be converted to TypeScript. pnpm chmods every `bin` target while it links a
// package, and in THIS workspace a `workspace:*` sibling is linked from its SOURCE dir,
// long before any build has produced `src/scripts/wp-finish-push-dev.js`. Pointing `bin` straight at the
// compiled path therefore makes every `pnpm install` print
// `WARN Failed to create bin ... ENOENT ... chmod` — noise indistinguishable from a real
// bin-link failure. This file exists in git, so the chmod always succeeds.
//
// See setupDebugging.md (Attempt 8) and bin-targets-exist.spec.ts, which fails if any
// `bin` target in the workspace does not exist on disk.
'use strict';

const path = require('path');
const fs = require('fs');

const compiled = path.join(__dirname, '..', 'src', 'scripts', 'wp-finish-push-dev.js');

if (!fs.existsSync(compiled)) {
    console.error(
        '  [pr-gate] wp-finish-push-dev: package not built yet. Run the build first, or install from npm.',
    );
    process.exit(1);
}

require(compiled);
