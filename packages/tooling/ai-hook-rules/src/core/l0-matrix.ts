import { CONFIG_FILENAME, writeTemplate } from '@webpieces/rules-config';

import { L0AllowEntry, L0Call, L0_ALLOWLIST, renderShim, shimStaleDenyReason } from '../bin/shim';
import { toError } from './to-error';

// ---------------------------------------------------------------------------
// L0 — the TOOLING-INTEGRITY layer, as data.
//
// L0 is the outermost guard: it blocks work while node_modules, the committed shim, or
// webpieces.config.json are in a state that makes every OTHER guard untrustworthy. It has SIX faults
// and — drawn as a decision matrix — NO genuine second dimension:
//
//     fault present AND call not on the allowlist  ->  BLOCK(messageFor(fault))
//
// so the only thing that varies per fault is the MESSAGE. This module holds the fault table and
// renders it, together with L0_ALLOWLIST (../bin/shim), into webpieces.guard-matrix.md — the doc the
// deny messages point the AI at. Doc and code come from the SAME arrays, so they cannot drift.
// ---------------------------------------------------------------------------

/** The doc L0's deny messages point at. Lives in @webpieces/rules-config/templates alongside the others. */
export const GUARD_MATRIX_DOC = 'webpieces.guard-matrix.md';

/**
 * One CURE for a fault: the exact call, plus the `mention` that must appear in that fault's deny text.
 *
 * Both halves are asserted (l0-matrix.spec.ts): the call must be accepted by isAllowed(), and the deny
 * message must actually name it. That pairing is the anti-deadlock invariant — a message that
 * prescribes a command the allowlist rejects is exactly the shape of the three deadlocks CLAUDE.md
 * records, and it is how the dead `wp-setup-ai-hooks` bin in the config-missing text was caught.
 */
export class L0Cure {
    constructor(
        readonly mention: string,
        readonly call: L0Call,
    ) {}
}

/** One L0 fault. Data-only → a class, per CLAUDE.md. */
export class L0Fault {
    constructor(
        readonly code: string,
        readonly name: string,
        readonly detectedBy: string,
        readonly enforcedIn: string,
        readonly cures: readonly L0Cure[],
        /**
         * The artifact carrying this fault's deny text. For S/C/Y that is the deny string itself; for
         * D/X/K the text is built in POSIX sh inside the rendered shim, so it is the rendered shim —
         * the same bytes the consumer runs, which is what the mention assertion needs to search.
         */
        readonly denyText: string,
    ) {}
}

// The deny for fault C, and the ONLY message L0 has for a repo with no webpieces.config.json at all.
// Moved here from runner.ts so the fault table and the runner cannot state different cures.
//
// It used to name `./node_modules/.bin/wp-setup-ai-hooks` — a bin that HAS NOT EXISTED since it was
// renamed to wp-install-ai-hooks. So the one command this deny prescribed was (a) not installable and
// (b) not on the L0 allowlist in that spelling, i.e. the AI was handed a cure it could neither run nor
// get past the guard. Now it names the installer that actually seeds the config AND is entry 8 of the
// allowlist, and it says out loud that writing the config yourself is allowed through.
export const CONFIG_MISSING_REPORT =
    `${CONFIG_FILENAME} not found — the webpieces guards cannot run without it, so every other tool call is blocked.\n` +
    'THIS IS NOT A DEADLOCK: both options below are explicitly allowed through while this guard is up.\n' +
    'OPTION 1 - run EXACTLY this command to seed the config (it also re-arms the hooks): `pnpm exec wp-install-ai-hooks`.\n' +
    `OPTION 2 - create ${CONFIG_FILENAME} yourself: any Read, and any Write/Edit whose target is\n` +
    `${CONFIG_FILENAME}, is always allowed through, so you can inspect the repo and write it.\n` +
    'Do not append anything to the option you pick — the allowlist is anchored to the whole command.';

// The first line of the fault-Y deny (built out in runner.checkConfigSync, which appends the per-rule
// detail). Kept here so the fault table quotes the same text the runner emits.
export const CONFIG_OUT_OF_SYNC_HEADER =
    `${CONFIG_FILENAME} is out of sync — new built-in rules are present that have no entry in ${CONFIG_FILENAME}.`;

const CONFIG_WRITE_CURE = new L0Cure(CONFIG_FILENAME, new L0Call('Edit', '', `/repo/${CONFIG_FILENAME}`));

// Cure calls are spelled exactly as the deny messages spell them, so the mention assertion is a real
// string search rather than a paraphrase.
// webpieces-disable no-function-outside-class -- pure constructor helper for the L0_FAULTS literal below, in this data module
function bashCure(command: string): L0Cure {
    return new L0Cure(command, new L0Call('Bash', command, ''));
}

/**
 * THE six L0 faults, in first-match-wins order. D/X/K are decided in POSIX sh BEFORE the bin runs (a
 * stale, missing or broken validator cannot be trusted to validate itself); S/C/Y are decided inside
 * the bin, in JS. One model, two enforcement points.
 */
export const L0_FAULTS: readonly L0Fault[] = [
    new L0Fault('D', 'version drift — root package.json pin != installed version',
        'sh, before the bin runs', 'sh',
        [bashCure('pnpm install'), bashCure('git pull')], renderShim()),
    new L0Fault('X', 'guard bin missing (fresh clone / new worktree / package removed)',
        'sh, before the bin runs', 'sh',
        [bashCure('pnpm install')], renderShim()),
    new L0Fault('K', 'guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules)',
        'sh, before the bin runs', 'sh',
        [bashCure('rm -rf node_modules && pnpm install')], renderShim()),
    new L0Fault('S', 'committed .claude/webpieces/ai-hook.sh != renderShim()',
        'the guard bin', 'JS',
        [bashCure('pnpm exec wp-install-ai-hooks'), bashCure('pnpm exec wp-upgrade-shim'),
            bashCure('cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh')],
        shimStaleDenyReason('')),
    new L0Fault('C', `${CONFIG_FILENAME} missing`,
        'the guard bin', 'JS',
        [bashCure('pnpm exec wp-install-ai-hooks'), CONFIG_WRITE_CURE], CONFIG_MISSING_REPORT),
    new L0Fault('Y', `a loaded rule has no ${CONFIG_FILENAME} key`,
        'the guard bin', 'JS',
        [CONFIG_WRITE_CURE], CONFIG_OUT_OF_SYNC_HEADER),
];

/**
 * Render webpieces.guard-matrix.md from L0_FAULTS + L0_ALLOWLIST.
 *
 * A unit test locks the committed template byte-identical to this output, the same way
 * templates/ai-hook.sh is locked to renderShim(). That is what makes the doc assertable instead of
 * aspirational: the table in the doc IS the array the guard consults.
 */
// webpieces-disable no-function-outside-class -- pure string builder over the two exported arrays, beside them in this module
export function renderGuardMatrixDoc(): string {
    return [
        '# webpieces guard matrix — L0 (tooling integrity)',
        '',
        'GENERATED from `L0_FAULTS` + `L0_ALLOWLIST` in `@webpieces/ai-hook-rules`. Do not hand-edit —',
        'a unit test locks this file byte-identical to `renderGuardMatrixDoc()`, so the table below is',
        'the array the guard actually consults, not a description of it.',
        '',
        'L0 is the OUTERMOST guard layer. It blocks work while `node_modules`, the committed shim, or',
        '`webpieces.config.json` are in a state that makes every other guard untrustworthy. If you are',
        'reading this, one of the six faults below fired and named this file.',
        '',
        '## The faults',
        '',
        '| code | fault | detected by | enforced in |',
        '|---|---|---|---|',
        ...L0_FAULTS.map((f: L0Fault): string => `| \`${f.code}\` | ${f.name} | ${f.detectedBy} | ${f.enforcedIn} |`),
        '',
        'First match wins. `D`/`X`/`K` are decided in POSIX `sh` inside the committed shim, BEFORE the',
        'guard bin runs — a stale, missing or broken validator cannot be trusted to validate itself.',
        '',
        '## The matrix',
        '',
        'L0 has NO genuine second dimension. Every branch reduces to one question:',
        '',
        '| # | fault | on the allowlist? | outcome |',
        '|---|---|---|---|',
        '| 1 | none | — | hand down to the next guard layer |',
        '| 2 | any | yes | PASS or ALLOW (see the entry) |',
        '| 3 | any | no | BLOCK — **only the message varies by fault** |',
        '',
        'The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check.',
        '',
        '## The allowlist',
        '',
        'ONE list, consulted identically by all six faults. A cure that cannot help a given fault also',
        'cannot hurt it, and gating each entry on a fault is what produced four real defects (a stale',
        'shim that denied `pnpm install` and `git pull`; faults that denied every Read; a config fault',
        'that denied `rm -rf node_modules && pnpm install` while allowing a bare `pnpm install`).',
        '',
        '| # | allowed | outcome |',
        '|---|---|---|',
        ...L0_ALLOWLIST.map((e: L0AllowEntry, i: number): string => `| ${i + 1} | ${e.label} | ${e.kind.toUpperCase()} |`),
        '',
        '- **PASS** — L0 has no objection; the call falls THROUGH so the downstream guards still judge it.',
        '- **ALLOW** — terminal; bypasses everything, because a cure must stay reachable even when a',
        '  downstream guard would block it.',
        '',
        'Every Bash entry is anchored to the WHOLE command. A leading `cd <dir> &&`, a trailing `2>&1`',
        'and a pipe into `tail`/`head` are tolerated; nothing else is. Appending `&& git status` makes it',
        'a DIFFERENT command and it is rejected again — that is not the guard refusing its own cure.',
        '',
        '`git merge` is deliberately NOT on this list. Main is merged ONLY through the 3-point fork merge',
        '(`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is already open).',
        '',
        '## Known asymmetry',
        '',
        'Under `S`/`C`/`Y` the guard bin IS running, so a PASS really does fall through to the downstream',
        'guards. Under `D`/`X`/`K` the bin is never executed, so there is nothing to fall through to and a',
        'PASS degenerates into a terminal allow — reads are unguarded during those three faults.',
        '',
        '## Widening L0',
        '',
        'Add an entry to `L0_ALLOWLIST` in `packages/tooling/ai-hook-rules/src/bin/shim.ts`. That array is',
        'the single source for the JS allowlist, the `grep -E` inside the rendered shim, and this file.',
        '',
    ].join('\n');
}

/**
 * Drop the matrix doc where the AI can read it, and return its absolute path ('' if it could not be
 * written). Called from the L0 BLOCK path so the deny can say `READ <path>`.
 *
 * Best-effort by design: this runs while the tree is already known-broken, and a missing template (an
 * @webpieces/rules-config older than this package) must degrade the deny message, never replace it
 * with a crash.
 */
// webpieces-disable no-function-outside-class -- sibling of renderGuardMatrixDoc in this module
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

/** The `READ <path>` pointer appended to an L0 deny, or '' when the doc could not be written. */
// webpieces-disable no-function-outside-class -- sibling of writeGuardMatrixDoc in this module
export function guardMatrixPointer(docPath: string): string {
    if (docPath === '') return '';
    return ` The full L0 guard matrix - all six faults and everything that is allowed through - is at ${docPath}; READ it if you are unsure why this call was blocked.`;
}
