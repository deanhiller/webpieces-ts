import * as fs from 'fs';
import * as path from 'path';

import { renderL1Doc } from '../packages/tooling/ai-hook-rules/src/core/l1-doc';

/**
 * Rewrite the GENERATED guard docs from the arrays the guards consult.
 *
 * `pnpm guards:generate`. A unit test locks each generated doc byte-identical to its renderer, so when
 * that test goes red this script is the one-command fix — never hand-edit the doc.
 *
 * L1 only, today. L0's generated half is a rules-config TEMPLATE (webpieces.guard-matrix.md) written by
 * its own writer; the other layers are still hand-written. GUARD_MATRIX.md's "Generation status" table
 * is the authority for which is which.
 */
// webpieces-disable no-function-outside-class -- a standalone generator script, not a library module
function main(): void {
    const root = path.resolve(__dirname, '..');
    const target = path.join(root, 'guards', 'L1-location.md');
    fs.writeFileSync(target, renderL1Doc(), 'utf8');
    process.stdout.write(`wrote ${target}\n`);
}

main();
