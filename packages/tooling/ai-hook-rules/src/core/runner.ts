import * as path from 'path';

import { loadAndValidate, LoadedConfig, WebpiecesRulesConfig, ExcludePaths, isWebpiecesStateDir, isHookGuard, HomeConfigService, RepoRootFinder, seedEntryForRule, CONFIG_FILENAME, renderRuleFailForAi } from '@webpieces/rules-config';

import { buildContexts, buildBashContext } from './build-context';
import { VersionSyncGuard } from './version-sync';
import { EffectiveTree, EffectiveTreeResolver } from './effective-tree';
import { ExcludedPathEscapeHint } from './excluded-path-escape';
import { gitFromSubdirBlock } from './force-to-root';
import { loadRules, loadMatchRules, loadKeylessBashRules, globMatches, GuardHintCommands } from './load-rules';
import { missingDirectoryBlock } from './missing-directory';
import { MatchRule } from './rules/match-rule';
import { branchStateHangTimeout, maybeRefreshMainSync } from './main-sync-timeout';
import { logGuardDecision, logL1Decision, GuardDecision, branchForLog, MatrixRef, Verdict, MATRIX_L0_ALLOW, MATRIX_L2_UNROWED } from './decision-log';
import { toError } from './to-error';
import { formatReport, READ_SUBJECT, BASH_SUBJECT } from './report';
import { ReadOnlyInspectionScan } from './read-only-inspection';
import { L0_ALLOW_JS, L0_CURE_ALLOW_JS, isRootManifest } from '../bin/shim';
import { L0_FAULT_CONFIG_MISSING, L0_FAULT_CONFIG_OUT_OF_SYNC, L0_FAULT_NONE } from './l0-fault-codes';
import { CONFIG_MISSING_REPORT, CONFIG_OUT_OF_SYNC_HEADER, writeGuardMatrixDoc, guardMatrixPointer } from './l0-matrix';
import { L1Classification, firstMatchingL1Row, L1_PRESTAGE_ROW } from './l1-rows';
import { withLocationMatrixPointer } from './l1-matrix-doc';
import {
    ToolKind, NormalizedToolInput, BlockedResult, HookMode,
    Rule, Violation, RuleGroup, RuleFailError, InformAiError,
    EditContext, FileContext, BashContext,
} from './types';

// Restrict loaded rules to the category this hook invocation runs. The two split hooks each pass a
// disjoint category ('rules' = code-style, 'guards' = the hookGuards section); 'all' runs both (the
// openclaw plugin adapter, a single before_tool_call hook). isHookGuard is the shared classifier in
// @webpieces/rules-config.
// isHookGuard is asked about the rule's CONFIG KEY, never its name. Since the collapse those differ
// for every class behind a policy key — `feature-branch-guard` is a rule NAME whose key is
// `branch-state-guard` — and asking about the name would classify all eight collapsed guards as
// code-style rules, i.e. run them in the wrong hook and never in the guards hook at all.
function filterByMode(rules: readonly Rule[], mode: HookMode): readonly Rule[] {
    if (mode === 'all') return rules;
    if (mode === 'guards') return rules.filter((r: Rule): boolean => isHookGuard(r.configKey));
    return rules.filter((r: Rule): boolean => !isHookGuard(r.configKey));
}

// Drop every rule excluded for this path (webpieces.config.json → excludePaths). ONE glob list: a path
// listed there is hands-off for code-style rules and file-scoped guards alike, because webpieces either
// governs a path or it does not. Per-rule carve-outs live in the rule's own `excludePaths`.
// This is L1's FILTER (not a table row) — see guards/L1-location.md.
export function filterByExcludedPaths(rules: readonly Rule[], relativePath: string, ex: ExcludePaths): readonly Rule[] {
    // webpieces' OWN gitignored state dir is never governed, config or no config. Ahead of the list on
    // purpose — see isWebpiecesStateDir for why it is code and not a seeded glob.
    if (isWebpiecesStateDir(relativePath)) return [];
    if (ex.paths.some((p: string): boolean => globMatches(p, relativePath))) return [];
    return rules;
}

// The cwd a command actually runs from, after its own leading `cd`/`pushd` run. Thin delegate kept
// for the callers (and specs) that only need the directory; the full tree classification — primary
// clone vs linked worktree vs nested clone vs outside any repo — is EffectiveTreeResolver.resolve().
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
export function effectiveBashCwd(command: string, cwd: string): string {
    return new EffectiveTreeResolver().effectiveCwd(command, cwd);
}

// The resolved gated-command strings the PR-lifecycle guards print, straight off the loaded
// `commands.guardHints`. Handed to the rules at construction rather than injected into their config
// entries under guard-name literals — the injection this replaces could miss a rename silently.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function guardHintsOf(loaded: LoadedConfig): GuardHintCommands {
    return new GuardHintCommands(loaded.commands.upsertPr, loaded.commands.mergeComplete);
}

// A git or gh invocation anywhere in the command (start, or after a ;/&&/|| separator or pipe).
const GIT_OR_GH_RE = /(?:^|[;&|]\s*)(?:git|gh)\b/;
export function isGitOrGhCommand(command: string): boolean {
    return GIT_OR_GH_RE.test(command);
}

// Fault C (webpieces.config.json missing) — the deny text lives in ./l0-matrix beside the rest of the
// L0 fault table, so the message and the allowlist can never prescribe different cures. `cwd` is used
// only to drop the matrix doc where the AI can read it (the config root does not exist yet here).
//
// `command` is '' on the file-tool path (there is no command to judge) and the Bash command otherwise:
// a call on the L0 allowlist survives this block, which is how read-only orientation stays available
// under C. You have to be able to see which tree you are standing in before you can decide what to
// write into the config. Returns null when the call is allowed through.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function configMissingBlock(cwd: string, command: string = ''): BlockedResult | null {
    if (command !== '' && l0FaultAllows(command)) return null;
    const root = new RepoRootFinder().resolveRepoRoot(cwd);
    // Stamped with its L0 letter so the block is greppable as fault C wherever it is recorded — the
    // adapter carries it to the audit line rather than re-deriving it from the report text.
    return new BlockedResult(CONFIG_MISSING_REPORT + guardMatrixPointer(writeGuardMatrixDoc(root)), L0_FAULT_CONFIG_MISSING);
}

export function run(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
    mode: HookMode = 'all',
): BlockedResult | null {
    return runInternal(toolKind, input, cwd, mode);
}

function runInternal(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
    mode: HookMode,
): BlockedResult | null {
    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null) return configMissingBlock(cwd);

    const workspaceRoot = path.dirname(loaded.configPath);

    // Always allow edits to webpieces.config.json — it's the fix target when out of sync
    if (path.resolve(input.filePath) === path.resolve(loaded.configPath)) {
        return null;
    }

    // …and the same PASS for the machine-local `~/.webpieces/config.json` (a bad key there fails a `wp-*`
    // command with an instruction to edit it, so blocking the edit would wedge the agent inside the
    // failure) and for the two ROOT MANIFESTS a pin lives in — L1 row 8 PROMISED that edit and its cure IS
    // it. isRootManifest, never a basename: this returns EARLY, so basename would unrule every
    // package.json in the repo. It admits any tree's root (the config sits beside it), which is what a
    // worktree's own cure needs — the same tree `workspaceRoot` above already names.
    if (isRootManifest(input.filePath) || new HomeConfigService().isHomeConfigPath(input.filePath)) {
        return null;
    }

    // Built-in/custom rules PLUS the client-authored match-rules (content guards). Match-rules run only
    // in the file-edit path (they are code-style, so filterByMode keeps them out of the bash/guards path).
    const allRules = [...loadRules(loaded.rulesConfig, workspaceRoot, guardHintsOf(loaded)), ...loadMatchRules(loaded.matchRules)];
    const modeRules = filterByMode(allRules, mode);
    if (modeRules.length === 0) return null;

    // Suppress enforcement for files under this category's excludePaths (e.g. vendored repos under
    // repositories/**). Exclusion is all-or-nothing per category, so an excluded file drops the whole
    // rule set and is fully hands-off — no violations AND no config-sync nag on those files.
    const relativePath = path.relative(workspaceRoot, input.filePath);
    const rules = filterByExcludedPaths(modeRules, relativePath, loaded.excludePaths);
    if (rules.length === 0) return null;

    // Config-sync applies only to built-in/custom rules; match-rules have their own validated section
    // (loadAndValidate already rejected an invalid `match-rules`), so they must not trip the sync nag.
    const outOfSync = checkConfigSync(rules.filter((r: Rule) => !(r instanceof MatchRule)), loaded.rulesConfig);
    if (outOfSync) return outOfSync;

    const contexts = buildContexts(toolKind, input, workspaceRoot);

    const editGroups = runEditRules(rules, contexts.editContexts);
    const fileGroups = runFileRules(rules, contexts.fileContext);
    const allGroups = [...editGroups, ...fileGroups];

    if (allGroups.length === 0) return null;

    const report = formatReport(relativePath, allGroups);
    return new BlockedResult(report);
}

// SINGLETON, deliberately: WebpiecesVersions memoizes per root, and the same two roots are asked for on
// every Bash call. A fresh instance per call would spawn `git worktree list` and re-read two manifests
// on the hook's blocking path each time.
const VERSION_SYNC = new VersionSyncGuard();

// There is deliberately NO agent parameter. It existed only for CoordinatorWorktreeGuard, which asked
// WHO was calling; that guard is gone and its replacement asks WHICH TREE the command acts on. Agent
// identity was measured untrustworthy for that question anyway — a worktree-isolated agent auto-reaped
// at a turn boundary silently resumes with its cwd on the primary clone — so a guard must never infer
// a tree from who is asking.
// webpieces-disable no-function-outside-class -- sibling of run()/runRead() in this module; the whole runner is module-scope functions and a lone class for this one entry point would break the file's shape
export function runBash(command: string, cwd: string, mode: HookMode = 'all'): BlockedResult | null {
    return runBashInternal(command, cwd, mode);
}

// The name of the ONLY rule permitted to block a Read. Reads are the highest-blast-radius tool
// there is, so this path is an explicit single-rule allowlist rather than the general rule loop.
const READ_SCOPED_GUARDS: ReadonlySet<string> = new Set(['read-stale-guard']);

/**
 * The Read path. Deliberately NOT `run()`:
 *
 *  - NO config-sync check. A rule present in code but missing from webpieces.config.json blocks
 *    every Write/Edit/Bash by design — but applying that to Read would mean an upgrade that adds
 *    any new rule instantly blocks the agent from reading the very config file it must edit to fix
 *    it. Reads must never carry that failure mode.
 *  - NO general rule loop. Only READ_SCOPED_GUARDS run, so no code-style rule can ever see a Read.
 *  - Fails OPEN everywhere, including on a thrown rule (the caller catches and allows).
 *
 * Returns null (allow) unless the one guard fires.
 */
// webpieces-disable no-function-outside-class -- sibling of run()/runBash() in this module; the whole runner is module-scope functions and a lone class for this one entry point would break the file's shape
export function runRead(filePath: string, cwd: string, mode: HookMode = 'all'): BlockedResult | null {
    // Code-style mode has nothing to say about a read.
    if (mode === 'rules') return null;

    const loaded = loadAndValidate(cwd);
    // No config → nothing to enforce. Unlike the edit path we do NOT block: an unconfigured repo
    // must still be readable.
    if (loaded.configPath === null) return null;

    const workspaceRoot = path.dirname(loaded.configPath);

    // Same git-repo-boundary governance as bash, through the SAME resolver: a read inside a different
    // clone is out of scope. (No command to parse here, so the shell cwd IS the effective cwd.)
    if (new EffectiveTreeResolver().resolve('', cwd, workspaceRoot).kind === 'foreign') return null;

    const relativePath = path.relative(workspaceRoot, filePath);
    const all = loadRules(loaded.rulesConfig, workspaceRoot, guardHintsOf(loaded));
    const rules = filterByExcludedPaths(
        all.filter((r: Rule): boolean => READ_SCOPED_GUARDS.has(r.name)),
        relativePath,
        loaded.excludePaths,
    );
    if (rules.length === 0) return null;

    const ctx = new FileContext('Read', filePath, relativePath, workspaceRoot, 0, 0, 0, 0);
    const groups = runFileRules(rules, ctx);
    if (groups.length === 0) return null;

    return new BlockedResult(formatReport(relativePath, groups, READ_SUBJECT));
}

// L0 cure bypass — every command on THE L0 allowlist passes here, ahead of any config load. A
// webpieces.config.json that is ahead of the installed validator (new rule tokens the published
// binary doesn't know yet) makes loadAndValidate() throw and would deny `pnpm install` — the very
// command that updates the validator (deadlock).
//
// This used to test INSTALLER_ALLOW_JS alone, which made the config faults (C = config missing,
// Y = config out of sync) accept a bare `pnpm install` while denying `rm -rf node_modules && pnpm
// install` — the one cure that works when node_modules is CORRUPT rather than merely stale. Same
// intent, opposite verdict, for no reason anyone recorded. Each alternative is still anchored at both
// ends, so `pnpm install && rm -rf /` still falls to the guards.
//
// It tests the CURE subset (L0_CURE_ALLOW_JS), not the whole list, and the distinction matters here
// and nowhere else: this call site runs BEFORE any fault has been established, so whatever it accepts
// is waved past the L1 guards on a perfectly healthy repo too. A repair command has to be waved past —
// it runs before the config can be loaded at all. Read-only ORIENTATION does not: it fixes nothing, and
// letting `git status` through here would delete force-to-root as a side effect of adding `pwd`. Under
// an actual fault, l0FaultAllows() below consults the WHOLE list.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function isL0CureCommand(command: string): boolean {
    return L0_CURE_ALLOW_JS.test(command.trim());
}

// The FULL L0 list, asked only where this file has actually detected an L0 fault (C = config missing,
// Y = config out of sync). Those two are the JS-side faults; D/X/K are decided in the shim, which greps
// the same union. Without this the orientation entry would be honoured under four faults and silently
// dropped under the other two — precisely the per-fault carve-out the L0 rewrite removed.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function l0FaultAllows(command: string): boolean {
    return L0_ALLOW_JS.test(command.trim());
}

// The L0 cure bypass's audit line. Anchored at the repo root that owns `.webpieces` — RepoRootFinder
// (config-walk-up first, then git toplevel) is the authority for that, and it is correct in a linked
// worktree because each worktree checks out its own webpieces.config.json. This runs BEFORE
// loadAndValidate, which is why it resolves the root itself rather than using workspaceRoot.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function logL0CureBypass(command: string, cwd: string): void {
    const root = new RepoRootFinder().resolveRepoRoot(cwd);
    logGuardDecision(root, new GuardDecision('-', 'Bash', command, branchForLog(root), 'ALLOW', 'L0 cure bypass (always allowed)', '-', L0_FAULT_NONE, MATRIX_L0_ALLOW));
}

/**
 * Load the config for the bash path — but do NOT let an unloadable config trap the tools needed to
 * repair it.
 *
 * loadAndValidate throws an InformAiError when webpieces.config.json is unparseable (a real syntax
 * error, or leftover `<<<<<<< HEAD` markers mid-merge) or fails validation. That throw propagates to
 * the hook adapter, which fails CLOSED and denies the command — correct for work, since a config that
 * did not load means no guards ran. But it denied `cat`/`grep`/`sed -n` on webpieces.config.json too,
 * i.e. it blocked the only way to see the problem it was reporting. Observed live, twice.
 *
 * So: on a load failure, a provably-inert INSPECTION command is allowed through (returns null, "no
 * block"), matching the escape hatch every other layer already grants this file. Everything else —
 * every write, every git/gh command, every build — still hits the same hard failure as before. The
 * bypass cannot be widened by accident; see ReadOnlyInspectionScan for how narrow "inert" is.
 *
 * Returns the loaded config, or null meaning "allow this command without guards".
 */
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function loadConfigOrAllowInspection(command: string, cwd: string): LoadedConfig | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrown unchanged unless the command is provably inert
    try {
        return loadAndValidate(cwd);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof InformAiError && new ReadOnlyInspectionScan().isReadOnlyInspection(command)) {
            return null;
        }
        throw error;
    }
}

// Version skew: this worktree pins a different @webpieces than the MAIN tree that governs it. The guard
// hooks are absolute, so the main tree's binary judges every tree — which is fine until the two trees
// disagree about which release that should be. L1 row 8; guards/L1-location.md carries the table.
// webpieces-disable no-function-outside-class -- sibling of the other module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function versionSkewBlock(command: string, tree: EffectiveTree): BlockedResult | null {
    const report = VERSION_SYNC.block(command, tree);
    return report === null ? null : new BlockedResult(report);
}

// Where the command lands in L1's five dimensions (K/A/R/G/P). The ONE place the runner's view of the
// world is translated into the matrix's vocabulary — see L1Classification.forEnforcement for why
// TreeKind 'outside' currently classifies as `p`.
// webpieces-disable no-function-outside-class -- sibling of the other module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function l1Classify(command: string, tree: EffectiveTree): L1Classification {
    return L1Classification.forEnforcement(
        tree.kind,
        VERSION_SYNC.skewed(tree),
        new ReadOnlyInspectionScan().isReadOnlyInspection(command),
        isGitOrGhCommand(command),
        path.resolve(tree.effectiveCwd) === path.resolve(tree.root),
    );
}

// The structural L1 blocks, in order: the misplaced-`cd` PRE-STAGE, then version skew (row 8), then
// force-to-root (row 5). None is a configurable rule — they are decided from the command text, the
// resolved tree and the caller, so they run as one step here rather than as three near-identical
// stanzas in runBashInternal.
//
// For the two TREE-BASED blocks the ORDER and the CHOICE are not written here: they come from L1_ROWS
// (l1-rows.ts), the same array guards/L1-location.md is rendered from. Classify, take the first
// matching row, dispatch on its blockId — so a row deleted from the array is a block that stops firing,
// and the doc cannot describe a table the guard does not consult. The two report builders below still
// own their own predicates and their deny strings; l1-matrix.spec.ts asserts the row lookup and those
// predicates agree.
//
// misplacedCdBlock is deliberately OUTSIDE that lookup, and runs ahead of it, for the reason its own
// docblock gives: it decides from command TEXT, before a tree has been resolved, and the other two
// reason FROM the resolved tree. Classifying it would mean asking L1_ROWS a question whose answer the
// classification itself depends on. It is the same shape as L2's `bareCheckoutOfMain` pre-stage. It is
// therefore ROW 0 — "pre-stage, decided from command text" — rather than a row among 1-6, which keeps
// it IN the table (the drift this table exists to prevent) without pretending it is classified over the
// same five dimensions. `L1_PRESTAGE_ROW` is the number the doc prints and `row=` logs, so the two join.
//
// THIS FUNCTION IS THE ONE PLACE L1 REPORTS. It is the only scope holding the classification, the
// matched row, the resolved tree and the agent at once — so logging here, BEFORE the early return,
// is what finally records the outcomes that were previously invisible: the exempt row and the three
// hand-downs wrote nothing at all, which is why "L1 had no objection" could not be observed and
// "show me every L1 decision" had no answer. The three block helpers no longer log for themselves —
// and, for the same reason, none of them knows about the matrix POINTER either: every deny is stamped
// with it HERE, from the same scope and the same row number, so deny and log line cannot disagree.
// webpieces-disable no-function-outside-class -- sibling of the other module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function l1LocationBlock(command: string, tree: EffectiveTree): BlockedResult | null {
    const misplacedCd = misplacedCdBlock(command, tree);
    if (misplacedCd !== null) {
        logL1(tree, command, 'BLOCK_AI_CURE', L1_PRESTAGE_ROW, 'cd-must-be-first', 'cd not leading/literal');
        return withLocationMatrixPointer(misplacedCd, tree.root, L1_PRESTAGE_ROW);
    }

    const row = firstMatchingL1Row(l1Classify(command, tree));
    const rowNum = String(row.num);
    if (row.blockId === null) {
        // ALLOW_EXEMPT stops here; ALLOW means "no objection, handed down to L2". Recording the
        // difference is the point — see Verdict. Neither claims the call RAN: the other parallel hook
        // may still have denied it.
        logL1(tree, command, row.action.kind === 'exempt' ? 'ALLOW_EXEMPT' : 'ALLOW', rowNum, '-', row.why);
        return null;
    }
    logL1(tree, command, 'BLOCK_AI_CURE', rowNum, row.blockId, row.why);
    if (row.blockId === 'missing-directory') return withLocationMatrixPointer(missingDirectoryBlock(command, tree), tree.root, rowNum);
    if (row.blockId === 'trinary-version-skew') return withLocationMatrixPointer(versionSkewBlock(command, tree), tree.root, rowNum);
    return withLocationMatrixPointer(gitFromSubdirBlock(command, tree, isGitOrGhCommand(command)), tree.root, rowNum);
}

// One L1 line, into L1's OWN stream. `row` is the number the generated doc prints, so a reader who sees
// `row=5` can open the L1 matrix at row 5 — the deny for that same call names it by absolute path.
// eslint-disable-next-line @typescript-eslint/max-params -- the six fields of one log line, and a class here would break this file's shape
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions
function logL1(tree: EffectiveTree, command: string, verdict: Verdict, row: string, rule: string, why: string): void {
    logL1Decision(tree.root, new GuardDecision(
        rule, 'Bash', command, branchForLog(tree.root), verdict, why, '-', L0_FAULT_NONE, new MatrixRef('L1', row),
    ));
}

/**
 * ONE legal shape for relocating a command: `cd <literal path> && <work>`. Anything else — a `cd` after
 * another command or after a `VAR=…` assignment, or a `cd "$DIR"` the guard cannot expand — is refused
 * here instead of being silently judged from the shell cwd.
 *
 * This changes no verdict: every command it refuses was ALREADY judged from the shell cwd, so nothing
 * it blocks was previously being allowed on the strength of its `cd`. What changes is that the agent
 * finds out. Two PRs of increasingly precise near-miss wording (#596, #597) still left the fact in a
 * paragraph appended to an unrelated block; the rule is simpler stated as a rule.
 *
 * FIRST in the L1 chain deliberately. version skew and force-to-root both reason from the
 * resolved tree, and if the `cd` did not resolve, that tree is not the one the agent thinks they are
 * in — so their remedies would be steering from a location the command does not actually run in.
 */
// webpieces-disable no-function-outside-class -- sibling of the other module-scope runner helpers; the whole runner is module-scope functions
function misplacedCdBlock(command: string, tree: EffectiveTree): BlockedResult | null {
    const reason = new EffectiveTreeResolver().misplacedCd(command);
    if (reason === null) return null;
    const report =
        `❌ A \`cd\` must come FIRST in the command, with a LITERAL path.\n` +
        `   Why this one was rejected: ${reason}.\n` +
        `   \`cd <literal path> && <work>\` is the ONE shape that moves where webpieces judges a command.\n` +
        `   Any other \`cd\` cannot be resolved, so the command would be judged against ${tree.root}\n` +
        `   — not where you think it runs. That used to happen silently; this block is that silence, spoken.\n` +
        `   Fix Option 1: put the \`cd\` first, literal path, SAME command:  cd /abs/path && <the rest>\n` +
        `   Fix Option 2: drop the \`cd\` — ${tree.root} is where the command is judged anyway.\n` +
        `   Fix Option 3: if the SECOND \`cd\` was there to point a tool at a directory, use that tool's own\n` +
        `                 directory flag instead — \`git -C <dir>\`, \`tar -C <dir>\`, \`npm --prefix <dir>\`,\n` +
        `                 \`npm pack --pack-destination <dir>\`, \`pnpm --dir <dir>\`. One \`cd\`, same result.\n` +
        `                 ONLY for a dir INSIDE this tree. \`git -C <another tree>\` is REFUSED to a subagent,\n` +
        `                 and is never the cure for a version skew — for that, tell the MAIN agent.\n` +
        `   Fix Option 4: split it — run the work in one call, the \`cd\` in another (a \`cd\` alone still\n` +
        `                 moves nothing the guards judge; see EffectiveTree on why cwd cannot be assumed).`;
    return new BlockedResult(report);
}

/**
 * The KEYLESS bash guards, deliberately kept OUT of the config-driven rule set. They have no
 * webpieces.config.json entry at all, so passing them through checkConfigSync would make every
 * consumer's next Bash call a fault-Y block ("this rule has no entry") for a feature nobody opted into
 * — which is exactly what whole-repo-build-guard did on its first release. Each one decides for itself
 * whether it acts: whole-repo-build-guard reads ~/.webpieces/config.json for a machine-local OPT-IN
 * (absent means OFF); commit-message-substitution-guard and build-output-pipe-guard act unconditionally.
 * They still honour excludePaths, and they do not run in `rules` mode (code-style-only hook).
 */
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function keylessBashRules(loaded: LoadedConfig, mode: HookMode, relativePath: string): readonly Rule[] {
    if (mode === 'rules') return [];
    return filterByExcludedPaths(
        loadKeylessBashRules(loaded.prGate.buildCommand), relativePath, loaded.excludePaths,
    );
}

// webpieces-disable no-function-outside-class -- sibling of run()/runBash() in this module; the whole runner is module-scope functions and a lone class for this one entry point would break the file's shape
function runBashInternal(command: string, cwd: string, mode: HookMode): BlockedResult | null {
    if (isL0CureCommand(command)) {
        logL0CureBypass(command, cwd);
        return null;
    }

    const loaded = loadConfigOrAllowInspection(command, cwd);
    // null = the config would not load AND this command only inspects → allow, see the helper.
    if (loaded === null) return null;
    if (loaded.configPath === null) return configMissingBlock(cwd, command); // fault C

    const workspaceRoot = path.dirname(loaded.configPath);

    // WHICH TREE does this command act on? Not the shell's cwd: a `cd` OUT of the workspace is reset
    // by the harness and one INSIDE it persists, so neither can be assumed (see EffectiveTree).
    // ONE resolver answers this for the guards AND for force-to-root below, so the two can never
    // disagree about which tree you are in.
    const tree = new EffectiveTreeResolver().resolve(command, cwd, workspaceRoot);

    // Git-repo-boundary governance: the command runs inside a DIFFERENT git repo than this
    // webpieces.config governs (e.g. a clone under repositories/). Out of scope → allow, hands-off.
    // Intentional, not a silent hole. A LINKED WORKTREE of this repo is deliberately NOT foreign — it
    // is the same project, so the guards run against THAT tree's branch and cache.
    if (tree.kind === 'foreign') {
        logGuardDecision(workspaceRoot, new GuardDecision('-', 'Bash', command, branchForLog(workspaceRoot), 'ALLOW_EXEMPT', 'foreign git repo (out of scope)', '-', L0_FAULT_NONE, new MatrixRef('L1', '1')));
        return null;
    }

    // Honour excludePaths on the bash path too (not just Read/Edit): a command whose effective
    // cwd sits under an excluded tree (e.g. repositories/**) drops the whole guard set — matching how
    // runInternal/runRead treat file paths. The relative path is '' when there is no `cd` (root), which
    // matches no exclusion glob, so a plain command at the repo root is unaffected.
    const relativeCwd = path.relative(workspaceRoot, tree.effectiveCwd);
    const rules = filterByExcludedPaths(
        filterByMode(loadRules(loaded.rulesConfig, workspaceRoot, guardHintsOf(loaded)), mode), relativeCwd, loaded.excludePaths,
    );
    const keyless = keylessBashRules(loaded, mode, relativeCwd);
    if (rules.length === 0 && keyless.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig); // fault Y — L0 list wins, as under C
    if (outOfSync) return l0FaultAllows(command) ? null : outOfSync;

    const locationBlock = l1LocationBlock(command, tree);
    if (locationBlock) return locationBlock;

    // Keep the feature-branch-guard cache warm on EVERY command (not just Write/Edit): the AI runs
    // far more bash than edits, so refreshing here means the guard's next file-edit check reads a
    // fresh status. Detached + fire-and-forget — never blocks the command. Only when the guard is
    // loaded (guards/all mode) and enabled, so a project that opted out never triggers git fetches.
    // Keyed on the JUDGED tree, so a worktree's cache is refreshed rather than the primary clone's.
    maybeRefreshMainSync(rules, tree.root, branchStateHangTimeout(loaded.rulesConfig));

    const groups = runBashRules([...rules, ...keyless], buildBashContext(command, tree));
    if (groups.length === 0) {
        // Record the ALLOW only for git/gh commands — the operations the bash guards actually reason
        // about (branch create, commit, push, merge, PR). Skipping ls/cat/grep keeps the audit log
        // focused (the whole point of the log is "why did/didn't a guard fire?"). Blocks are always
        // logged below.
        if (/\b(?:git|gh)\b/.test(command)) {
            logGuardDecision(tree.root, new GuardDecision('-', 'Bash', command, branchForLog(tree.root), 'ALLOW', 'no bash-guard block', '-', L0_FAULT_NONE, MATRIX_L2_UNROWED));
        }
        return null;
    }

    const ruleNames = groups.map((g: RuleGroup): string => g.ruleName).join(',');
    logGuardDecision(tree.root, new GuardDecision(ruleNames, 'Bash', command, branchForLog(tree.root), 'BLOCK_AI_CURE', 'bash-guard block', '-', L0_FAULT_NONE, MATRIX_L2_UNROWED));
    const report = new ExcludedPathEscapeHint(workspaceRoot, tree.effectiveCwd).render(command, loaded.excludePaths)
        + formatReport(commandLabel(command), groups, BASH_SUBJECT) + exemptTreesHint(groups, loaded.excludePaths.paths);
    return new BlockedResult(report);
}

// The bash report's subject line. It used to be the literal string `<bash>`, which told the agent
// nothing; the command itself is what was blocked, so name it — truncated, because a heredoc-bearing
// command can run to thousands of characters and the violation lines already carry the detail.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function commandLabel(command: string): string {
    const oneLine = command.replace(/\s+/g, ' ').trim();
    const MAX = 100;
    return oneLine.length <= MAX ? oneLine : oneLine.slice(0, MAX) + '…';
}

// When a push/PR block fires AND the config exempts vendored/nested trees, surface the escape hatch the
// AI cannot otherwise discover: git/gh run UNGUARDED inside those trees if it cd's there first (each is
// governed by its own repo, not this one). Scoped to pr-creation-or-push-guard — for the other guards
// "cd into an exempt tree" is not the remedy — and emitted only when such trees are actually configured,
// so a repo without exemptions never sees the noise.
//
// The hint MUST state the precondition, not just the remedy. "cd into it first" is true only for a
// LITERAL cd at the FRONT of the same command; `D=…; cd "$D"; git push` lands in the identical
// directory and does NOT relocate the verdict. That used to be silent, then a near-miss paragraph
// appended here; it is now misplacedCdBlock, which refuses the command outright — so by the time this
// footer is reached, any `cd` in the command is already known to be leading and literal. The wording
// still states the shape, because this is where an agent LEARNS it, before writing the next command.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function exemptTreesHint(groups: readonly RuleGroup[], exemptGuards: readonly string[]): string {
    if (exemptGuards.length === 0) return '';
    if (!groups.some((g: RuleGroup): boolean => g.ruleName === 'pr-creation-or-push-guard')) return '';

    return `\n\nℹ️  Working in a nested repo under one of these exempt trees (${exemptGuards.join(', ')})? `
        + `Put a LITERAL \`cd\` at the FRONT of the SAME command — \`cd /abs/path/to/repo && git push\` — and git/gh `
        + `run normally there: the webpieces guards do NOT govern them (each is its own repo).`
        + `\n   \`cd <literal path> && <work>\` is the ONE shape that moves where a command is judged. A \`cd\` `
        + `anywhere else in the line, or a non-literal target like \`cd "$DIR"\`, is refused outright rather than `
        + `judged from somewhere you did not intend.`;
}

// The set of CONFIG KEYS explicitly present in webpieces.config.json (every key except rulesDir).
function configuredRuleNames(config: WebpiecesRulesConfig): ReadonlySet<string> {
    return new Set(Object.keys(config).filter((k: string) => k !== 'rulesDir'));
}

/**
 * Fault Y — a loaded rule whose CONFIG KEY has no entry.
 *
 * Compared on `configKey`, not `name`. Eight of the loaded rules are classes behind two policy keys, so
 * comparing names here would demand entries named `feature-branch-guard`, `pr-merge-guard` and six
 * others — keys the validator then REJECTS as retired. That is the two-enforcement-paths deadlock this
 * repo has already hit once (see the narration in guards.spec.ts), and it blocks every Bash/Write/Edit.
 *
 * De-duplicated on the key too, so one missing policy entry reports ONE paste-ready snippet rather than
 * four copies of the same one under four different headings.
 */
function checkConfigSync(rules: readonly Rule[], config: WebpiecesRulesConfig): BlockedResult | null {
    const configured = configuredRuleNames(config);
    const seen = new Set<string>();
    const unconfiguredRules = rules.filter((r: Rule): boolean => {
        if (configured.has(r.configKey) || seen.has(r.configKey)) return false;
        seen.add(r.configKey);
        return true;
    });
    if (unconfiguredRules.length === 0) return null;

    // ONE action, no menu, no escalation — the config-validation invariant (guards/L0-tooling.md): every
    // config problem cures to "make the file right", and editing it is never denied. This message used
    // to tell the agent to interview the human about each rule; agents did not do it, so the block just
    // stalled. Each rule now ships a paste-ready entry at its recommended mode.
    //
    // Note this is the CONFIG-BEHIND-CODE direction. The opposite one — the config names a rule the
    // installed validator has no schema for — is unknownRuleError() in rules-config/validate-config.ts
    // and surfaces in the validation banner, not here.
    const lines = [
        // Fault Y's header lives in ./l0-matrix beside the rest of the L0 fault table (same reason as
        // CONFIG_MISSING_REPORT: one place states what this fault is and what cures it).
        CONFIG_OUT_OF_SYNC_HEADER,
        '',
        `Add an entry for each rule below to ${CONFIG_FILENAME}. Editing that file is ALWAYS allowed through`,
        'the guard — including right now, while this block is up — so paste the entries and retry.',
        '',
        'Each entry below is ready to paste at its recommended mode; adjust the option values if your',
        'project needs different ones.',
        '',
        `Do NOT delete a rule from ${CONFIG_FILENAME} to silence it — an entry is REQUIRED for every rule,`,
        'and "mode": "OFF" is how a rule is turned off.',
        '',
    ];

    for (const rule of unconfiguredRules) {
        lines.push(`--- ${rule.configKey} ---`);
        lines.push(`Description: ${rule.description}`);
        const opts = rule.defaultOptions;
        const optKeys = Object.keys(opts);
        if (optKeys.length > 0) {
            lines.push(`Available options (suggested defaults shown):`);
            for (const key of optKeys) {
                lines.push(`  ${key}: ${JSON.stringify(opts[key])}`);
            }
        } else {
            lines.push('Available options: none beyond mode');
        }
        // The SAME entry the installer would seed: recommended mode, both hatches, and every other
        // schema-required field — so pasting it satisfies the loader in one pass.
        lines.push(`Entry to add to ${CONFIG_FILENAME}:`);
        lines.push(`  "${rule.configKey}": ${JSON.stringify(seedEntryForRule(rule.configKey))}`);
        lines.push('');
    }

    // Fault Y, stamped for the audit trail — see configMissingBlock for why the producer names it.
    return new BlockedResult(lines.join('\n'), L0_FAULT_CONFIG_OUT_OF_SYNC);
}

// N-legs pattern: each rule runs independently so one rule can never abort the others. A rule may
// EITHER return Violation[] OR throw — both accumulate here into visible violations the AI sees:
//  - a thrown RuleFailError  → an expected, well-formed violation (its line/snippet/fixOptions kept);
//  - a thrown plain Error    → a "crashed" violation (a bug, surfaced not swallowed).
export function runRuleCheck(rule: Rule, ctx: EditContext | FileContext | BashContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) {
            return [violationFromRuleFail(error)];
        }
        return [new Violation(0, '', `Rule '${rule.name}' crashed: ${error.message}`)];
    }
}

// A thrown RuleFailError carries its own AI-facing message + optional location and cures. Fold the
// cures into the message because Violation has no fixHint field (RuleGroup's fixHint comes from the
// rule definition, not a per-throw value). The "Fix Option N:"/"(preferred)" labels come from the ONE
// framework-owned renderer, exactly as report.ts renders a rule's static FixHint — a rule never
// hand-numbers its own cures.
function violationFromRuleFail(error: RuleFailError): Violation {
    return new Violation(error.line ?? 0, error.snippet ?? '', renderRuleFailForAi(error));
}

function ruleMatchesFile(rule: Rule, relativePath: string): boolean {
    for (const pattern of rule.files) {
        if (globMatches(pattern, relativePath)) return true;
    }
    return false;
}

function runBashRules(rules: readonly Rule[], bashContext: BashContext): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'bash') continue;
        if (!rule.shouldRun()) continue;
        const vs = runRuleCheck(rule, bashContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, rule.fixHint, [...vs],
            ));
        }
    }
    return groups;
}

function runEditRules(rules: readonly Rule[], editContexts: readonly EditContext[]): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'edit') continue;
        if (!rule.shouldRun()) continue;
        const allViolations: Violation[] = [];
        for (const ctx of editContexts) {
            if (!ruleMatchesFile(rule, ctx.relativePath)) continue;
            const vs = runRuleCheck(rule, ctx);
            for (const v of vs) {
                const copy = new Violation(v.line, v.snippet, v.message);
                copy.editIndex = ctx.editIndex;
                copy.editCount = ctx.editCount;
                allViolations.push(copy);
            }
        }
        if (allViolations.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, rule.fixHint, allViolations,
            ));
        }
    }
    return groups;
}

function runFileRules(rules: readonly Rule[], fileContext: FileContext): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'file') continue;
        if (!rule.shouldRun()) continue;
        if (!ruleMatchesFile(rule, fileContext.relativePath)) continue;
        const vs = runRuleCheck(rule, fileContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, rule.fixHint, [...vs],
            ));
        }
    }
    return groups;
}
