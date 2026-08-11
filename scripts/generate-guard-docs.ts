import * as fs from 'fs';
import * as path from 'path';

import { renderL1Doc } from '../packages/tooling/ai-hook-rules/src/core/l1-doc';
import { renderL2Doc } from '../packages/tooling/ai-hook-rules/src/core/l2-doc';
import { L0ToolingDoc } from '../packages/tooling/ai-hook-rules/src/core/l0-tooling-doc';
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
 *             `guards/L2-branch-state.md` — rendered from L2_ROWS. L2 does not DISPATCH from its rows
 *             the way L1 does (its four guard classes each own their own ladder, deliberately); the
 *             join is by REASON — see l2-rows.ts.
 *             `guards/L0-tooling.md` — PARTLY rendered: the block between the two markers
 *             (`L0_DOC_BEGIN`/`L0_DOC_END`) is spliced from L0_FAULTS + L0_ALLOWLIST + the managed-surface
 *             constants + SHIM_LOG_FIELDS; every byte outside it is hand-written prose and is preserved.
 *             That doc is the largest guard doc in the repo and the only hand-written one, and it is the
 *             only one that has ever gone stale — twice in one session.
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

    const l2 = path.join(root, 'guards', 'L2-branch-state.md');
    fs.writeFileSync(l2, renderL2Doc(), 'utf8');
    wrote.push(l2);

    // L0's doc is SPLICED, not overwritten: read what is committed, replace only the marked block, write
    // it back. splice() throws when the marker pair is missing or doubled, so a doc that silently stopped
    // being generated fails here rather than drifting quietly.
    const l0 = path.join(root, 'guards', 'L0-tooling.md');
    fs.writeFileSync(l0, new L0ToolingDoc().splice(fs.readFileSync(l0, 'utf8')), 'utf8');
    wrote.push(l0);

    const templates = path.join(root, 'packages', 'tooling', 'ai-hook-rules', 'templates');
    const shim = path.join(templates, 'ai-hook.sh');
    fs.writeFileSync(shim, renderShim(), { mode: 0o755 });
    wrote.push(shim);

    for (const target of wrote) process.stdout.write(`wrote ${target}\n`);
}

main();
