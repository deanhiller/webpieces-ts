import * as path from 'path';

import { loadAndValidate, LoadedConfig, WebpiecesRulesConfig, ExcludePaths, isHookGuard, DEFAULT_HANG_TIMEOUT_MINUTES, HomeConfigService, RepoRootFinder, seedEntryForRule, CONFIG_FILENAME } from '@webpieces/rules-config';

import { buildContexts, buildBashContext } from './build-context';
import { AgentIdentity, CoordinatorWorktreeGuard, UNKNOWN_AGENT } from './coordinator-worktree';
import { EffectiveTree, EffectiveTreeResolver, atRoot } from './effective-tree';
import { loadRules, loadMatchRules, globMatches } from './load-rules';
import { MatchRule } from './rules/match-rule';
import { triggerMainSyncRefresh } from './main-sync-refresh';
import { logGuardDecision, logL1Decision, GuardDecision, branchForLog, MatrixRef, Verdict } from './decision-log';
import { toError } from './to-error';
import { formatReport, READ_SUBJECT, BASH_SUBJECT } from './report';
import { ReadOnlyInspectionScan } from './read-only-inspection';
import { L0_ALLOW_JS, L0_CURE_ALLOW_JS } from '../bin/shim';
import { L0_FAULT_CONFIG_MISSING, L0_FAULT_CONFIG_OUT_OF_SYNC, L0_FAULT_NONE } from './l0-fault-codes';
import { CONFIG_MISSING_REPORT, CONFIG_OUT_OF_SYNC_HEADER, writeGuardMatrixDoc, guardMatrixPointer } from './l0-matrix';
import { L1Classification, firstMatchingL1Row, L1_PRESTAGE_ROW } from './l1-rows';
import {
    ToolKind, NormalizedToolInput, BlockedResult, HookMode,
    Rule, Violation, RuleGroup, RuleFailError, InformAiError,
    EditContext, FileContext, BashContext,
} from './types';

// Restrict loaded rules to the category this hook invocation runs. The two split hooks each pass a
// disjoint category ('rules' = code-style, 'guards' = the hookGuards section); 'all' runs both (the
// openclaw plugin adapter, a single before_tool_call hook). isHookGuard is the shared classifier in
// @webpieces/rules-config.
function filterByMode(rules: readonly Rule[], mode: HookMode): readonly Rule[] {
    if (mode === 'all') return rules;
    if (mode === 'guards') return rules.filter((r: Rule): boolean => isHookGuard(r.name));
    return rules.filter((r: Rule): boolean => !isHookGuard(r.name));
}

// Drop every rule excluded for this path (webpieces.config.json → excludePaths). ONE glob list: a path
// listed there is hands-off for code-style rules and file-scoped guards alike, because webpieces either
// governs a path or it does not. Per-rule carve-outs live in the rule's own `excludePaths`.
// This is L1's FILTER (not a table row) — see guards/L1-location.md.
export function filterByExcludedPaths(rules: readonly Rule[], relativePath: string, ex: ExcludePaths): readonly Rule[] {
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

// A git or gh invocation anywhere in the command (start, or after a ;/&&/|| separator or pipe).
const GIT_OR_GH_RE = /(?:^|[;&|]\s*)(?:git|gh)\b/;
export function isGitOrGhCommand(command: string): boolean {
    return GIT_OR_GH_RE.test(command);
}

// Fire-and-forget the detached refresher when feature-branch-guard is loaded and active, so the
// cache (.webpieces/main-sync-status.json) stays fresh as the AI works. The guard rule itself also
// triggers this on Write/Edit; this covers the Bash path so the cache is warm on every command.
function maybeRefreshMainSync(rules: readonly Rule[], workspaceRoot: string): void {
    const guard = rules.find((r: Rule): boolean => r.name === 'feature-branch-guard');
    if (guard && guard.shouldRun()) {
        triggerMainSyncRefresh(workspaceRoot, DEFAULT_HANG_TIMEOUT_MINUTES);
    }
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

    // …and the same unconditional PASS for the OPTIONAL machine-local `~/.webpieces/config.json`, for the
    // identical reason. That file is strictly validated when it exists (HomeConfigService), so a bad key
    // in it makes a `wp-*` command fail with an instruction to edit it — and a guard that then blocked
    // that edit would wedge the agent inside the failure. webpieces.config.json is immune to exactly this
    // because of the pass above; the home config gets the same immunity rather than a different answer.
    // Matches the absolute, `~/`, `$HOME/` and `${HOME}/` spellings alike (see isHomeConfigPath).
    if (new HomeConfigService().isHomeConfigPath(input.filePath)) {
        return null;
    }

    // Built-in/custom rules PLUS the client-authored match-rules (content guards). Match-rules run only
    // in the file-edit path (they are code-style, so filterByMode keeps them out of the bash/guards path).
    const allRules = [...loadRules(loaded.rulesConfig, workspaceRoot), ...loadMatchRules(loaded.matchRules)];
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

// `agent` defaults to UNKNOWN_AGENT — NOT the coordinator. Only the Claude Code adapter can read
// agent_id/agent_type off the payload; every other caller (the openclaw adapter, library consumers,
// the existing specs) genuinely does not know, and a caller who does not know must not be guessed
// into a coordinator-only block. See UNKNOWN_AGENT.
// webpieces-disable no-function-outside-class -- sibling of run()/runRead() in this module; the whole runner is module-scope functions and a lone class for this one entry point would break the file's shape
export function runBash(command: string, cwd: string, mode: HookMode = 'all', agent: AgentIdentity = UNKNOWN_AGENT): BlockedResult | null {
    return runBashInternal(command, cwd, mode, agent);
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
    const all = loadRules(loaded.rulesConfig, workspaceRoot);
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

// Force-to-root: git/gh commands must run from the repo root of the tree they act on, where the guards
// can reason about git state coherently. L1 row 4 — see guards/L1-location.md for the table
// and the use cases; change this predicate and that file is stale until you update it.
//
// ONE variable decides it: `tree.effectiveCwd` — the directory the command actually runs in, which is
// the shell's cwd unless the command leads with `cd <dir> &&`. Root or not-root, nothing else.
//
// It used to be `shellAtRoot || cdsToRoot`, two variables OR'd, and that produced opposite verdicts for
// the same destination: `git status` with the shell in packages/http/ was BLOCKED, while
// `cd packages/http && git status` from the root was ALLOWED, because shellAtRoot short-circuited
// before the destination was ever considered. The point of this guard is to keep the agent's git work
// at the root — an agent that cd's INTO a subdir has the same broken mental model as one that is
// stranded there, so it gets the same answer now.
//
// The remedy is emitted as ONE runnable line, `cd <root> && <the original command>`, rather than as
// "cd first, then re-run". That advice is what made this guard print the very command it had just
// rejected, and it is unreliable in both directions: a `cd` INTO this repo sticks (so the next call
// may start somewhere unexpected), while a `cd` OUT of it is reset by the harness (so a separate
// `cd <worktree>` call buys nothing). One self-contained line is correct either way.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function gitFromSubdirBlock(command: string, tree: EffectiveTree): BlockedResult | null {
    const targetAtRoot = path.resolve(tree.effectiveCwd) === path.resolve(tree.root);
    if (!isGitOrGhCommand(command) || targetAtRoot) return null;
    const report =
        `❌ Run git/gh commands from the repo root, not a subdirectory.\n` +
        `   Command runs in: ${tree.effectiveCwd}\n` +
        `   Judged against: ${tree.root}\n` +
        `   Run EXACTLY this instead, as ONE line (a bare \`cd\` in a separate call is not equivalent —\n` +
        `   a \`cd\` inside this repo STICKS for later calls, and a \`cd\` out of it is reset by the harness):\n` +
        `     ${atRoot(tree.root, command)}\n` +
        `   A leading \`cd <path> &&\` is ACCEPTED by the guards — it cannot change what the command\n` +
        `   does to the repo. (The webpieces guards evaluate the repo's git state at its root.)`;
    return new BlockedResult(report);
}

// The L0 cure bypass's audit line. Anchored at the repo root that owns `.webpieces` — RepoRootFinder
// (config-walk-up first, then git toplevel) is the authority for that, and it is correct in a linked
// worktree because each worktree checks out its own webpieces.config.json. This runs BEFORE
// loadAndValidate, which is why it resolves the root itself rather than using workspaceRoot.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function logL0CureBypass(command: string, cwd: string): void {
    const root = new RepoRootFinder().resolveRepoRoot(cwd);
    logGuardDecision(root, new GuardDecision('-', 'Bash', command, branchForLog(root), 'ALLOW', 'L0 cure bypass (always allowed)'));
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

// Coordinator-in-worktree: the coordinator's governance is anchored at session start and does NOT
// follow a `cd`, so a coordinator working inside a linked worktree has its filesystem in one tree and
// its guards in another. L1 row 3 — guards/L1-location.md carries the table and the incident; the
// predicate and the message are CoordinatorWorktreeGuard's.
// webpieces-disable no-function-outside-class -- sibling of gitFromSubdirBlock() and the other module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function coordinatorInWorktreeBlock(command: string, tree: EffectiveTree, agent: AgentIdentity): BlockedResult | null {
    const report = new CoordinatorWorktreeGuard().block(command, tree, agent);
    if (report === null) return null;
    return new BlockedResult(report);
}

// Where the command lands in L1's five dimensions (K/A/R/G/P). The ONE place the runner's view of the
// world is translated into the matrix's vocabulary — see L1Classification.forEnforcement for why
// TreeKind 'outside' currently classifies as `p`.
// webpieces-disable no-function-outside-class -- sibling of gitFromSubdirBlock() and the other module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function l1Classify(command: string, tree: EffectiveTree, agent: AgentIdentity): L1Classification {
    return L1Classification.forEnforcement(
        tree.kind,
        agent.coordinator,
        new ReadOnlyInspectionScan().isReadOnlyInspection(command),
        isGitOrGhCommand(command),
        path.resolve(tree.effectiveCwd) === path.resolve(tree.root),
    );
}

// The structural L1 blocks, in order: the misplaced-`cd` PRE-STAGE, then coordinator-in-worktree
// (row 3), then force-to-root (row 5). None is a configurable rule — they are decided from the command
// text, the resolved tree and the caller, so they run as one step here rather than as three
// near-identical stanzas in runBashInternal.
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
// classification itself depends on. It is the same shape as L2's `bareCheckoutOfMain` pre-stage.
//
// It is therefore ROW 0 — "pre-stage, decided from command text" — rather than a row among 1-6. That
// keeps it IN the table (the drift this table exists to prevent) without pretending it is classified
// over the same five dimensions, which is the thing that cannot be true. `L1_PRESTAGE_ROW` is the
// number the doc prints and the number `row=` logs, so the two still join.
//
// THIS FUNCTION IS THE ONE PLACE L1 REPORTS. It is the only scope holding the classification, the
// matched row, the resolved tree and the agent at once — so logging here, BEFORE the early return,
// is what finally records the outcomes that were previously invisible: the exempt row and the three
// hand-downs wrote nothing at all, which is why "L1 had no objection" could not be observed and
// "show me every L1 decision" had no answer. The three block helpers no longer log for themselves.
// webpieces-disable no-function-outside-class -- sibling of gitFromSubdirBlock() and the other module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function l1LocationBlock(command: string, tree: EffectiveTree, agent: AgentIdentity): BlockedResult | null {
    const misplacedCd = misplacedCdBlock(command, tree);
    if (misplacedCd !== null) {
        logL1(tree, command, 'BLOCK_AI_CURE', L1_PRESTAGE_ROW, 'cd-must-be-first', 'cd not leading/literal');
        return misplacedCd;
    }

    const row = firstMatchingL1Row(l1Classify(command, tree, agent));
    const rowNum = String(row.num);
    if (row.blockId === null) {
        // ALLOW_EXEMPT stops here; ALLOW means "no objection, handed down to L2". Recording the
        // difference is the point — see Verdict. Neither is a claim that the call actually ran: the
        // parallel L-1 hook may still have denied it.
        logL1(tree, command, row.action.kind === 'exempt' ? 'ALLOW_EXEMPT' : 'ALLOW', rowNum, '-', row.why);
        return null;
    }
    logL1(tree, command, 'BLOCK_AI_CURE', rowNum, row.blockId, row.why);
    if (row.blockId === 'coordinator-in-worktree') return coordinatorInWorktreeBlock(command, tree, agent);
    return gitFromSubdirBlock(command, tree);
}

// One L1 line, into L1's OWN stream. `row` is the number the generated doc prints, so a reader who
// sees `row=5` can open guards/L1-location.md at row 5 and read the state, the cure and the use cases
// that row is supposed to cover.
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
 * FIRST in the L1 chain deliberately. coordinator-in-worktree and force-to-root both reason from the
 * resolved tree, and if the `cd` did not resolve, that tree is not the one the agent thinks they are
 * in — so their remedies would be steering from a location the command does not actually run in.
 */
// webpieces-disable no-function-outside-class -- sibling of gitFromSubdirBlock(); the whole runner is module-scope functions
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
        `   Fix Option 3: split it — run the work in one call, the \`cd\` in another (a \`cd\` alone still\n` +
        `                 moves nothing the guards judge; see EffectiveTree on why cwd cannot be assumed).`;
    return new BlockedResult(report);
}

// webpieces-disable no-function-outside-class -- sibling of run()/runBash() in this module; the whole runner is module-scope functions and a lone class for this one entry point would break the file's shape
function runBashInternal(command: string, cwd: string, mode: HookMode, agent: AgentIdentity): BlockedResult | null {
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
        logGuardDecision(workspaceRoot, new GuardDecision('-', 'Bash', command, branchForLog(workspaceRoot), 'ALLOW', 'foreign git repo (out of scope)'));
        return null;
    }

    // Honour excludePaths on the bash path too (not just Read/Edit): a command whose effective
    // cwd sits under an excluded tree (e.g. repositories/**) drops the whole guard set — matching how
    // runInternal/runRead treat file paths. The relative path is '' when there is no `cd` (root), which
    // matches no exclusion glob, so a plain command at the repo root is unaffected.
    const rules = filterByExcludedPaths(
        filterByMode(loadRules(loaded.rulesConfig, workspaceRoot), mode),
        path.relative(workspaceRoot, tree.effectiveCwd),
        loaded.excludePaths,
    );
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig); // fault Y — L0 list wins, as under C
    if (outOfSync) return l0FaultAllows(command) ? null : outOfSync;

    const locationBlock = l1LocationBlock(command, tree, agent);
    if (locationBlock) return locationBlock;

    // Keep the feature-branch-guard cache warm on EVERY command (not just Write/Edit): the AI runs
    // far more bash than edits, so refreshing here means the guard's next file-edit check reads a
    // fresh status. Detached + fire-and-forget — never blocks the command. Only when the guard is
    // loaded (guards/all mode) and enabled, so a project that opted out never triggers git fetches.
    // Keyed on the JUDGED tree, so a worktree's cache is refreshed rather than the primary clone's.
    maybeRefreshMainSync(rules, tree.root);

    const ctx = buildBashContext(command, tree);
    const groups = runBashRules(rules, ctx);
    if (groups.length === 0) {
        // Record the ALLOW only for git/gh commands — the operations the bash guards actually reason
        // about (branch create, commit, push, merge, PR). Skipping ls/cat/grep keeps the audit log
        // focused (the whole point of the log is "why did/didn't a guard fire?"). Blocks are always
        // logged below.
        if (/\b(?:git|gh)\b/.test(command)) {
            logGuardDecision(tree.root, new GuardDecision('-', 'Bash', command, branchForLog(tree.root), 'ALLOW', 'no bash-guard block'));
        }
        return null;
    }

    const ruleNames = groups.map((g: RuleGroup): string => g.ruleName).join(',');
    logGuardDecision(tree.root, new GuardDecision(ruleNames, 'Bash', command, branchForLog(tree.root), 'BLOCK_AI_CURE', 'bash-guard block'));
    const report = formatReport(commandLabel(command), groups, BASH_SUBJECT) + exemptTreesHint(groups, loaded.excludePaths.paths);
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

// The set of rule names explicitly present in webpieces.config.json (every key except rulesDir).
function configuredRuleNames(config: WebpiecesRulesConfig): ReadonlySet<string> {
    return new Set(Object.keys(config).filter((k: string) => k !== 'rulesDir'));
}

function checkConfigSync(rules: readonly Rule[], config: WebpiecesRulesConfig): BlockedResult | null {
    const configured = configuredRuleNames(config);
    const unconfiguredRules = rules.filter((r: Rule) => !configured.has(r.name));
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
        lines.push(`--- ${rule.name} ---`);
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
        lines.push(`  "${rule.name}": ${JSON.stringify(seedEntryForRule(rule.name))}`);
        lines.push('');
    }

    // Fault Y, stamped for the audit trail — see configMissingBlock for why the producer names it.
    return new BlockedResult(lines.join('\n'), L0_FAULT_CONFIG_OUT_OF_SYNC);
}

// N-legs pattern: each rule runs independently so one rule can never abort the others. A rule may
// EITHER return Violation[] OR throw — both accumulate here into visible violations the AI sees:
//  - a thrown RuleFailError  → an expected, well-formed violation (its line/snippet/fixHints kept);
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

// A thrown RuleFailError carries its own AI-facing message + optional location and fix hints. Fold the
// fix hints into the message because Violation has no fixHint field (RuleGroup's fixHint comes from the
// rule definition, not a per-throw value).
function violationFromRuleFail(error: RuleFailError): Violation {
    const hints = error.fixHints.length > 0 ? `\n  Fix: ${error.fixHints.join('\n  Fix: ')}` : '';
    return new Violation(error.line ?? 0, error.snippet ?? '', error.aiMessage + hints);
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
