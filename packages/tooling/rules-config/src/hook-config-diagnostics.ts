import { CONFIG_FILENAME } from './config-file';
export const READ_COMMANDS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat']);
export const CODEX_READ_CMD = "sed -n '1,240p' package.json";
import { L0_FAULT_CONFIG_MISSING, L0_FAULT_CONFIG_OUT_OF_SYNC, l0GuardHeader, l0MatrixCitation } from './hook-fault-codes';

export const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';
export const PACKAGE_MANIFEST = 'package.json';
export const MANIFEST_FILENAMES: ReadonlySet<string> = new Set([WORKSPACE_MANIFEST, PACKAGE_MANIFEST]);

export const CODEX_READ_STILL_ALLOWED =
    `on CODEX (no Read tool): a bare read command - ${[...READ_COMMANDS].join('/')} <file>, `
    + `or ${CODEX_READ_CMD} - with nothing piped, redirected or chained onto it`;

export const CONFIG_MISSING_REPORT = [
    `❌ webpieces ai-hooks blocked this call: ${CONFIG_FILENAME} not found.`,
    '',
    l0GuardHeader(L0_FAULT_CONFIG_MISSING, '1 violation'),
    `  ${CONFIG_FILENAME}`,
    '    → the webpieces guards cannot run without it, so every OTHER tool call is blocked.',
    `    → ${l0MatrixCitation(L0_FAULT_CONFIG_MISSING)}`,
    '',
    'Still allowed while this block is up:',
    `  - any Read, and ${CODEX_READ_STILL_ALLOWED}`,
    `  - any Write/Edit whose target is ${CONFIG_FILENAME}`,
    '  - every command on the L0 allowlist, including the Fix Options below',
    '  THIS IS NOT A DEADLOCK - run one YOURSELF now; do not hand it back to the human.',
    '',
    `  Fix Option 1: (preferred) it needs no other tool and it never prompts - create ${CONFIG_FILENAME}`,
    '    yourself. The validator reports EVERY missing/invalid entry at once (each with the snippet to',
    '    paste), so a minimal first draft converges in about two passes.',
    '  Fix Option 2: pick this ONLY at an interactive terminal where you can answer its two prompts - it',
    '    goes on to wire the Claude Code hooks and asks for a target twice, which hangs a non-interactive',
    '    session.',
    '    run EXACTLY: `pnpm exec wp-install-ai-hooks`',
    '',
    'Do not append anything to the option you pick — the allowlist is anchored to the whole command.',
].join('\n');

// The HEADER of the fault-Y deny (built out in runner.checkConfigSync, which appends the per-rule
// detail as the `[…]` block's offenders). Kept here so the fault table quotes the same text the runner
// emits, and so Y opens with the same `[guard-name] (layer=L0 fault=Y row=3)` coordinates as every
// other L0 fault — that triple is what joins the deny to the audit line and to the matrix row.
export const CONFIG_OUT_OF_SYNC_HEADER = [
    `❌ webpieces ai-hooks blocked this call: ${CONFIG_FILENAME} is out of sync.`,
    '',
    l0GuardHeader(L0_FAULT_CONFIG_OUT_OF_SYNC, '1 violation'),
    `  new built-in rules are present that have no entry in ${CONFIG_FILENAME}`,
    `    → ${l0MatrixCitation(L0_FAULT_CONFIG_OUT_OF_SYNC)}`,
].join('\n');


import { writeTemplate } from './load-template';
import { toError } from '@webpieces/tooling-common/to-error';
export const GUARD_MATRIX_DOC = 'webpieces.guard-matrix.md';

// webpieces-disable no-function-outside-class -- shared best-effort configuration diagnostic template writer
export function writeGuardMatrixDoc(workspaceRoot: string): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return writeTemplate(workspaceRoot, GUARD_MATRIX_DOC);
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: no doc → the deny simply omits the pointer
        return '';
    }
}

/**
 * The `READ <path>` pointer appended to an L0 deny, or '' when the doc could not be written.
 *
 * It opens with a NEWLINE, not a space: the JS-side L0 denies render in the house format now (a header,
 * a `[guard-name]` block, `Fix Option N:` lines), so a pointer glued onto the end of the last line would
 * be the one place the shape broke. A real newline is safe on both call paths — denyJson() JSON.stringifies
 * it, exactly as it does for every multi-line L1 report.
 */
// webpieces-disable no-function-outside-class -- sibling of writeGuardMatrixDoc in this module
export function guardMatrixPointer(docPath: string): string {
    if (docPath === '') return '';
    return `\nThe full L0 guard matrix - every fault and everything that is allowed through - is at ${docPath}; READ it if you are unsure why this call was blocked.`;
}
