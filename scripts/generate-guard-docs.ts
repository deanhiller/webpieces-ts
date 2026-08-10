import * as fs from 'fs';
import * as path from 'path';

import { renderL1Doc } from '../packages/tooling/ai-hook-rules/src/core/l1-doc';
import { renderShim } from '../packages/tooling/ai-hook-rules/src/bin/shim';

/**
 * Rewrite every GENERATED guard artifact from the arrays and renderers the guards consult.
 *
 * `pnpm guards:generate`. A unit test locks each output byte-identical to its renderer, so when that
 * test goes red this script is the one-command fix — never hand-edit a generated file.
 *
 * TWO KINDS of output, and the difference matters:
 *
 *   docs      `guards/L1-location.md` — rendered from L1_ROWS, the array the guard itself consults.
 *   templates `packages/tooling/ai-hook-rules/templates/ai-hook.sh` — the POSIX-sh hook, rendered from
 *             renderShim(). These used to have NO command at all: their
 *             byte-lock specs quoted a `fs.writeFileSync(...)` snippet in a comment for a human to
 *             paste. A regeneration step that only exists as a comment is one nobody runs, which is
 *             how a renderer change turns into a red build with no obvious fix.
 *
 * WHAT THIS DELIBERATELY DOES NOT WRITE: `.claude/webpieces/*.sh`, the copies this repo actually runs.
 * Those must match the INSTALLED PUBLISHED release, not local source (see the one-release lag in
 * CLAUDE.md) — L0 fault S compares them against the published renderShim() on every tool call, so
 * committing a locally-rendered copy would hard-block every call in the repo until the next publish.
 * `pnpm exec wp-upgrade-shim` is what writes those, from node_modules, after a release.
 *
 * L0's generated doc half is a rules-config TEMPLATE (webpieces.guard-matrix.md) written by its own
 * writer. GUARD_MATRIX.md's "Generation status" table is the authority for which layer is which.
 */
// webpieces-disable no-function-outside-class -- a standalone generator script, not a library module
function main(): void {
    const root = path.resolve(__dirname, '..');
    const wrote: string[] = [];

    const doc = path.join(root, 'guards', 'L1-location.md');
    fs.writeFileSync(doc, renderL1Doc(), 'utf8');
    wrote.push(doc);

    const templates = path.join(root, 'packages', 'tooling', 'ai-hook-rules', 'templates');
    const shim = path.join(templates, 'ai-hook.sh');
    fs.writeFileSync(shim, renderShim(), { mode: 0o755 });
    wrote.push(shim);

    for (const target of wrote) process.stdout.write(`wrote ${target}\n`);
}

main();
