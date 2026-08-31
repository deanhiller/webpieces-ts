import { CONFIG_FILENAME, writeTemplate } from '@webpieces/rules-config';

import {
    ADD_HOOK_PKG_CMD, CHECKOUT_MAIN_PULL_CMD, HOOK_PKG, INSTALL_HOOKS_CMD, L0AllowEntry, L0Call,
    L0_ALLOWLIST, RECOVERY_CMD, RESTORE_SHIM_CMD, SHIM_MARKER, UPGRADE_SHIM_CMD, renderShim,
} from '../bin/shim';
import { ENV_SURFACE, HARNESS_REGISTRATIONS, HarnessRegistration } from '../bin/hook-registration';
import { shimStaleDenyReason } from '../bin/shim-deny-reason';
import {
    L0_FAULT_BIN_BROKEN, L0_FAULT_BIN_MISSING, L0_FAULT_CONFIG_MISSING, L0_FAULT_CONFIG_OUT_OF_SYNC,
    L0_FAULT_DRIFT, L0_FAULT_NAMES, L0_FAULT_SHIM_STALE, L0_FAULT_UNDECLARED, L0FaultCode,
    L0_ROW_ALLOWLISTED, L0_ROW_BLOCKED, l0GuardHeader, l0MatrixCitation,
} from './l0-fault-codes';
import { toError } from './to-error';

// ---------------------------------------------------------------------------
// L0 — the TOOLING-INTEGRITY layer, as data.
//
// L0 is the outermost guard: it blocks work while node_modules, the committed shim, or
// webpieces.config.json are in a state that makes every OTHER guard untrustworthy. Its faults are
// enumerated in L0_FAULTS below and — drawn as a decision matrix — have NO genuine second dimension:
//
//     fault present AND call not on the allowlist  ->  BLOCK(messageFor(fault))
//
// so the only thing that varies per fault is the MESSAGE. This module holds the fault table and
// renders it, together with L0_ALLOWLIST (../bin/shim), into webpieces.guard-matrix.md — the doc the
// deny messages point the AI at. Doc and code come from the SAME arrays, so they cannot drift.
// ---------------------------------------------------------------------------

/**
 * The doc L0's deny messages point at. Lives in @webpieces/rules-config/templates alongside the others,
 * and is written to <root>/.webpieces/instruct-ai/ lazily, only on an L0 BLOCK.
 *
 * That generated doc is the AUTHORITY for the fault table and the allowlist (same arrays, cannot
 * drift). guards/L0-tooling.md is the hand-written companion: it adds L0's evaluation
 * ORDER, the use cases and the known gaps, and it documents L1, none of which are rendered from code.
 * Change L0_FAULTS or L0_ALLOWLIST and the generated doc follows automatically — guards/L0-tooling.md does
 * not, so update it in the same PR.
 */
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
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly mention: string,
        readonly call: L0Call,
        /**
         * The one to reach for first when a fault has several. Exactly one cure per fault carries it,
         * so the rendered Fix section never asks the reader to choose between equals.
         */
        readonly preferred: boolean,
        /**
         * WHEN to pick this cure over its siblings — the sentence that makes a list of commands
         * actionable instead of a menu ("when the PIN is the stale side", not "an alternative").
         */
        readonly discriminator: string,
    ) {}

    /** A Bash cure renders as a literal command; a tool-shaped one renders as the edit it stands for. */
    isCommand(): boolean {
        return this.call.toolName === 'Bash';
    }
}

/** One L0 fault. Data-only → a class, per CLAUDE.md. */
export class L0Fault {
    constructor(
        /**
         * The codebook's letter — typed as the UNION of every declared code, not `string`, so
         * `L0_FAULT_NAMES[code]` is total and neither this module nor the deny builders need a
         * `?? 'unknown'` fallback. A fault added without a name fails to compile.
         */
        readonly code: L0FaultCode,
        readonly name: string,
        readonly detectedBy: string,
        readonly enforcedIn: string,
        readonly cures: readonly L0Cure[],
        /**
         * The artifact carrying this fault's deny text. For S/C/Y that is the deny string itself; for
         * D/X/U/K the text is built in POSIX sh inside the rendered shim, so it is the rendered shim —
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
//
// ORDERING (2026-08-02): writing the file yourself now LEADS. The bare installer used to be OPTION 1,
// but it seeds the config and then PROMPTS twice for a hook target, which hangs a non-interactive
// agent. Writing the file is the one cure that always works, and it is the same cure every other config
// problem has (see the config-validation invariant in guards/L0-tooling.md): the validator reports every
// error at once, so the write/validate loop converges in a couple of passes.
export const CONFIG_MISSING_REPORT = [
    `❌ webpieces ai-hooks blocked this call: ${CONFIG_FILENAME} not found.`,
    '',
    l0GuardHeader(L0_FAULT_CONFIG_MISSING, '1 violation'),
    `  ${CONFIG_FILENAME}`,
    '    → the webpieces guards cannot run without it, so every OTHER tool call is blocked.',
    `    → ${l0MatrixCitation(L0_FAULT_CONFIG_MISSING)}`,
    '',
    'Still allowed while this block is up:',
    '  - any Read',
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

// Writing/repairing the file yourself. PREFERRED for both config faults, per the config-validation
// invariant in guards/L0-tooling.md: every config problem cures to "make the file right", the validator
// reports all errors at once so the loop converges in a couple of passes, and allowlist entry 2 permits
// this edit unconditionally. (That section is the authority — do not restate its reasoning here.)
const CONFIG_WRITE_CURE = new L0Cure(
    CONFIG_FILENAME, new L0Call('Edit', '', `/repo/${CONFIG_FILENAME}`), true,
    'this fault fires at all — it is the only cure that needs no other tool, and it is never denied',
);

// Cure calls are spelled exactly as the deny messages spell them, so the mention assertion is a real
// string search rather than a paraphrase.
// webpieces-disable no-function-outside-class -- pure constructor helper for the L0_FAULTS literal below, in this data module
function bashCure(command: string, preferred: boolean, discriminator: string): L0Cure {
    return new L0Cure(command, new L0Call('Bash', command, ''), preferred, discriminator);
}

/**
 * THE L0 faults, in first-match-wins order. D/X/U/K are decided in POSIX sh BEFORE the bin runs (a
 * stale, missing or broken validator cannot be trusted to validate itself); S/C/Y are decided inside
 * the bin, in JS. One model, two enforcement points.
 */
export const L0_FAULTS: readonly L0Fault[] = [
    new L0Fault(L0_FAULT_DRIFT, 'version drift — root package.json pin != installed version',
        'sh, before the bin runs', 'sh',
        [
            // `pnpm install` clears D in BOTH directions — it makes installed == pin by definition — so
            // it is always the preferred cure. The direction only decides whether the PIN is the version
            // you WANT, which is what the second cure is for.
            bashCure('pnpm install', true,
                'node_modules is OLDER than the pin, OR you are on a feature branch and want YOUR '
                + 'branch pin (usually the case) — it always clears the drift'),
            // The on-main sync is spelled `git checkout main && git pull origin main` and NOT `git pull`:
            // a raw pull on a FEATURE branch merges main into it and destroys the fork point, so it is
            // no longer on the L0 allowlist at all (see CHECKOUT_MAIN_PULL_BODY_ERE). This spelling ends
            // ON main, which is why it is safe from any branch — and it is a no-op checkout when you are
            // already there.
            //
            // And it is RAW GIT on purpose, where the workflow guards now say `pnpm wp-checkout-clean-main`
            // instead. The fault being cured here is `node_modules` disagreeing with the pin, so
            // `node_modules` is the untrustworthy thing — and every `pnpm wp-*` bin resolves through it.
            // An L0 cure may never be a command that has to load the package it is repairing. See the
            // long note on CHECKOUT_MAIN_PULL_BODY_ERE in bin/l0-allowlist.ts.
            bashCure(CHECKOUT_MAIN_PULL_CMD, false,
                'node_modules is NEWER than the pin AND you are on main — the PIN is the stale side, so '
                + 'sync first and install second; a bare install would downgrade you'),
        ], renderShim()),
    new L0Fault(L0_FAULT_BIN_MISSING, 'guard bin missing (fresh clone / new worktree / package removed)',
        'sh, before the bin runs', 'sh',
        [bashCure('pnpm install', true,
            'this fault fires at all — nothing is installed in THIS tree, and a new git worktree '
            + 'copies no node_modules')],
        renderShim()),
    // U is X with the ONE input that inverts X's cure, which is why it is a separate fault and not a
    // sentence inside X's message: when nothing declares the package, `pnpm install` is not a weaker fix,
    // it is a PROVABLE no-op, and an agent that trusts the X text will run it until it gives up. See the
    // ADD_HOOK_PKG entry in l0-allowlist.ts for the incident.
    new L0Fault(L0_FAULT_UNDECLARED, `guard bin missing AND ${HOOK_PKG} is not declared in package.json`,
        'sh, before the bin runs', 'sh',
        [bashCure(ADD_HOOK_PKG_CMD, true,
            'this fault fires at all — package.json asks for nothing, so pnpm install reports '
            + '"Lockfile is up to date" and leaves the tree exactly as broken as it found it')],
        renderShim()),
    new L0Fault(L0_FAULT_BIN_BROKEN, 'guard bin present but CRASHED (exit code not 0 or 2 — corrupt node_modules)',
        'sh, before the bin runs', 'sh',
        [bashCure(RECOVERY_CMD, true,
            'this fault fires at all — a BARE pnpm install SKIPS the corrupt package, because pnpm sees '
            + 'the right version on disk and considers it installed; only the delete forces a rewrite')],
        renderShim()),
    // S covers the WHOLE managed hook surface, not just the shim: the committed ai-hook.sh, the
    // .claude/settings.json entries that register them AND the managed `env` entry that pins the Bash
    // cwd so the hooks resolve identically for every subagent. They only work as a set — a settings file left
    // on a superseded form silently changes who governs, re-pinning every tree to the
    // primary's release — and nothing validated the registration at all before it joined this fault.
    new L0Fault(L0_FAULT_SHIM_STALE, 'a webpieces-managed hook file, one of the harness hook registrations (.claude/settings.json, .codex/hooks.json) or the managed env entry does not match this release',
        'the guard bin', 'JS',
        [
            // wp-upgrade-shim leads because it is the ONLY cure that repairs EVERY managed surface, and
            // it is still surgical: it rewrites ai-hook.sh, each harness's registration and the env entry
            // and touches no config, and it imports only fs/path so it runs on a tree too broken to load
            // the rule engine. The INSTALLER is deliberately NOT a cure here: it also migrates the config
            // and prompts for a target twice, which hangs a non-interactive agent.
            bashCure(UPGRADE_SHIM_CMD, true,
                'this fault fires at all — it is the only cure that repairs EVERY managed surface '
                + '(ai-hook.sh, each harness hook registration, and the Claude settings env entry), and it also '
                + 'deletes the retired guarantee-root.sh and any entry still naming it, and it '
                + 'touches no config; needs installed @webpieces/ai-hook-rules 0.4.408 or newer'),
            // 2026-07-21: the version gap below caused a real "command not found" deadlock.
            bashCure(RESTORE_SHIM_CMD, false,
                'the installed @webpieces/ai-hook-rules is OLDER than 0.4.408, so wp-upgrade-shim does '
                + 'not exist yet — it is PARTIAL (it repairs ai-hook.sh and NOTHING else), so upgrade '
                + '@webpieces afterwards and run Option 1 to finish'),
        ],
        // The SAMPLE deny renders EVERY managed surface, built from HARNESS_REGISTRATIONS rather than
        // a hand-written trio — a doc that shows a three-surface deny while the guard can report four
        // is exactly the drift this generated-doc arrangement exists to make impossible.
        shimStaleDenyReason('', '', [
            SHIM_MARKER,
            ...HARNESS_REGISTRATIONS.map((h: HarnessRegistration): string => h.registrationSurface),
            ENV_SURFACE,
        ], false)),
    new L0Fault(L0_FAULT_CONFIG_MISSING, `${CONFIG_FILENAME} missing`,
        'the guard bin', 'JS',
        [
            CONFIG_WRITE_CURE,
            // Kept, but demoted: it seeds the file and then PROMPTS twice for a hook target.
            bashCure(INSTALL_HOOKS_CMD, false,
                'you are at an INTERACTIVE terminal and can answer its two hook-target prompts'),
        ], CONFIG_MISSING_REPORT),
    new L0Fault(L0_FAULT_CONFIG_OUT_OF_SYNC, `a loaded rule has no ${CONFIG_FILENAME} key`,
        'the guard bin', 'JS',
        [CONFIG_WRITE_CURE], CONFIG_OUT_OF_SYNC_HEADER),
];

/**
 * One fault's FIX section, rendered from its `cures` array — literal commands only, never prose.
 *
 * This is the half that used to live in hand-written docs and drift. The three fields of L0Cure map
 * onto the three things a blocked reader needs and nothing else: WHAT to type (the call), WHETHER it is
 * the default (preferred), and WHEN to pick a sibling instead (discriminator). A cure with no
 * discriminator would render as a menu of equals, which is how an agent picks the wrong one.
 */
// webpieces-disable no-function-outside-class -- pure string builder for renderGuardMatrixDoc below, beside the arrays it reads
function renderFixSection(fault: L0Fault): string[] {
    const options = fault.cures.map((cure: L0Cure, i: number): string => {
        // A Bash cure is the command verbatim; a tool-shaped one is the file it edits (allowlist entry 2).
        const literal = cure.isCommand() ? `\`${cure.call.command}\`` : `edit \`${cure.mention}\` yourself`;
        const label = cure.preferred ? `Option ${i + 1} (preferred)` : `Option ${i + 1}`;
        return `- **${label}**: ${literal}  ← pick this when ${cure.discriminator}`;
    });
    return [`### \`${fault.code}\` — ${fault.name}`, '', ...options, ''];
}

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
        'reading this, one of the faults below fired and named this file.',
        '',
        '## The faults',
        '',
        'THE JOIN KEYS ARE `guard`, `fault=` and `row=`. Every L0 deny opens',
        '`[<guard>] (layer=L0 fault=<code> row=3, …)`, and every audit line — from BOTH halves of L0, the',
        '`sh` shim and the guard bin — carries `layer=L0 row=<n> fault=<code>`. So one grep lands you in',
        'the deny, the log line and the row below. The guard names come from `L0_FAULT_NAMES` and the row',
        'numbers from `L0_ROW_*`, both spelled in exactly one place (`core/l0-fault-codes.ts`).',
        '',
        '| code | guard | fault | detected by | enforced in |',
        '|---|---|---|---|---|',
        ...L0_FAULTS.map((f: L0Fault): string =>
            `| \`${f.code}\` | \`${L0_FAULT_NAMES[f.code]}\` | ${f.name} | ${f.detectedBy} | ${f.enforcedIn} |`),
        '',
        'First match wins. `D`/`X`/`U`/`K` are decided in POSIX `sh` inside the committed shim, BEFORE the',
        'guard bin runs — a stale, missing or broken validator cannot be trusted to validate itself.',
        '',
        '## The fix, per fault',
        '',
        'Every command below is rendered from that fault\'s `cures` array and is asserted, by unit test,',
        'to be accepted by `isAllowed()` — so nothing here can be a command the guard then rejects. Type',
        'the option you pick EXACTLY as written and run nothing else on that line.',
        '',
        ...L0_FAULTS.flatMap(renderFixSection),
        ...renderMatrixAndAllowlist(),
    ].join('\n');
}

/**
 * The second half of the doc: the three-row matrix and the ONE allowlist. Split out of
 * renderGuardMatrixDoc solely to keep it inside the method-line budget — the join order is what makes
 * the two halves one file, so keep them adjacent and keep the byte-lock test as the arbiter.
 */
// webpieces-disable no-function-outside-class -- second half of renderGuardMatrixDoc's string, beside it in this module
function renderMatrixAndAllowlist(): string[] {
    return [
        '## The matrix',
        '',
        'L0 has NO genuine second dimension. Every branch reduces to one question:',
        '',
        '| # | fault | on the allowlist? | outcome |',
        '|---|---|---|---|',
        '| 1 | none | — | hand down to the next guard layer |',
        `| ${L0_ROW_ALLOWLISTED} | any | yes | PASS or ALLOW (see the entry) |`,
        `| ${L0_ROW_BLOCKED} | any | no | BLOCK — **only the message varies by fault** |`,
        '',
        `Row ${L0_ROW_BLOCKED} is the only row that blocks, so every L0 deny cites it — \`row=${L0_ROW_BLOCKED}\` in the`,
        'deny header, `row=' + L0_ROW_BLOCKED + '` on the audit line, and this row here. Same numbers as L1 uses for',
        'its own rows (see `L1_ROWS`), and for the same reason: a row number is IDENTITY, so it is never reused.',
        '',
        'The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check.',
        '',
        '## The allowlist',
        '',
        'ONE list, consulted identically by every fault. A cure that cannot help a given fault also',
        'cannot hurt it, and gating each entry on a fault is what produced four real defects (a stale',
        'shim that denied `pnpm install` and every git sync; faults that denied every Read; a config fault',
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
        'guards. Under `D`/`X`/`U`/`K` the bin is never executed, so there is nothing to fall through to and a',
        'PASS degenerates into a terminal allow — reads are unguarded during those three faults.',
        '',
        '## Widening L0',
        '',
        'Add an entry to `L0_ALLOWLIST` in `packages/tooling/ai-hook-rules/src/bin/shim.ts`. That array is',
        'the single source for the JS allowlist, the `grep -E` inside the rendered shim, and this file.',
        '',
    ];
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
