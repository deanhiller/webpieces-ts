import * as path from 'path';

import { loadAndValidate, WebpiecesRulesConfig, ExcludePaths, isHookGuard, DEFAULT_HANG_TIMEOUT_MINUTES, RepoRootFinder } from '@webpieces/rules-config';

import { buildContexts, buildBashContext } from './build-context';
import { EffectiveTree, EffectiveTreeResolver, atRoot } from './effective-tree';
import { loadRules, loadMatchRules, globMatches } from './load-rules';
import { MatchRule } from './rules/match-rule';
import { triggerMainSyncRefresh } from './main-sync-refresh';
import { logGuardDecision, GuardDecision, branchForLog } from './decision-log';
import { toError } from './to-error';
import { formatReport, READ_SUBJECT, BASH_SUBJECT } from './report';
import { INSTALLER_ALLOW_JS } from '../bin/shim';
import {
    ToolKind, NormalizedToolInput, BlockedResult, HookMode,
    Rule, Violation, RuleGroup, RuleFailError,
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

// Drop rules whose category is excluded for this file path (webpieces.config.json → excludePaths).
// Two independent glob lists: `guards` suppresses file-scoped guards (e.g. feature-branch-guard),
// `rules` suppresses code-style rules — so a vendored tree can be exempt from one but not the other.
// Only file tools reach here; bash git/PR guards (no file path) are never affected.
export function filterByExcludedPaths(rules: readonly Rule[], relativePath: string, ex: ExcludePaths): readonly Rule[] {
    return rules.filter((r: Rule): boolean => {
        const patterns = isHookGuard(r.name) ? ex.guards : ex.rules;
        return !patterns.some((p: string): boolean => globMatches(p, relativePath));
    });
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

const CONFIG_MISSING_REPORT =
    'webpieces.config.json not found.\n' +
    'Tell the human: run `./node_modules/.bin/wp-setup-ai-hooks` to initialize the project configuration.\n' +
    'Do not proceed until the human has done this.';

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
    if (loaded.configPath === null) return new BlockedResult(CONFIG_MISSING_REPORT);

    const workspaceRoot = path.dirname(loaded.configPath);

    // Always allow edits to webpieces.config.json — it's the fix target when out of sync
    if (path.resolve(input.filePath) === path.resolve(loaded.configPath)) {
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

// Installer bypass — package-manager install commands ALWAYS pass, ahead of any config load. A
// webpieces.config.json that is ahead of the installed validator (new rule tokens the published
// binary doesn't know yet) makes loadAndValidate() throw and would deny `pnpm install` — the very
// command that updates the validator (deadlock). Mirrors the fail-closed shim's INSTALLER_ALLOW_ERE
// (missing-bin case); INSTALLER_ALLOW_JS is its locked JS twin. Match is tight (`pnpm install` /
// `npm i` + `--flags`, plus an optional LEADING `cd <path> &&` so the cure is typable from a
// worktree) so `pnpm install && rm -rf /` still falls to the guards.
function isInstallerCommand(command: string): boolean {
    return INSTALLER_ALLOW_JS.test(command.trim());
}

// Force-to-root: git/gh commands must run from the repo root of the tree they act on, where the guards
// can reason about git state coherently. Fires ONLY when the shell is STUCK in a governed subdir — the
// shell persists in a subdir AND the command does not `cd` to a tree root (`tree.root`, which is the
// linked worktree's root when the command cd's into one). A command that explicitly cd's to a root is
// judged by the normal guards, never here.
//
// The remedy is emitted as ONE runnable line, `cd <root> && <the original command>`, because `cd` does
// not persist between tool calls: telling the agent to "cd first, then re-run" costs a turn and the
// next call starts back in the old directory anyway. The bare-`cd` advice is what made this guard
// print the very command it had just rejected.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function gitFromSubdirBlock(command: string, tree: EffectiveTree): BlockedResult | null {
    const shellAtRoot = path.resolve(tree.shellCwd) === path.resolve(tree.root);
    const cdsToRoot = path.resolve(tree.effectiveCwd) === path.resolve(tree.root);
    if (!isGitOrGhCommand(command) || shellAtRoot || cdsToRoot) return null;
    const report =
        `❌ Run git/gh commands from the repo root, not a subdirectory.\n` +
        `   You are in: ${tree.shellCwd}\n` +
        `   Judged against: ${tree.root}\n` +
        `   Run EXACTLY this instead (one line — \`cd\` does NOT persist between tool calls):\n` +
        `     ${atRoot(tree.root, command)}\n` +
        `   A leading \`cd <path> &&\` is ACCEPTED by the guards — it cannot change what the command\n` +
        `   does to the repo. (The webpieces guards evaluate the repo's git state at its root.)`;
    logGuardDecision(tree.root, new GuardDecision('force-to-root', 'Bash', command, branchForLog(tree.root), 'BLOCK', 'git/gh from subdir'));
    return new BlockedResult(report);
}

// The installer bypass's audit line. Anchored at the repo root that owns `.webpieces` — RepoRootFinder
// (config-walk-up first, then git toplevel) is the authority for that, and it is correct in a linked
// worktree because each worktree checks out its own webpieces.config.json. This runs BEFORE
// loadAndValidate, which is why it resolves the root itself rather than using workspaceRoot.
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function logInstallerBypass(command: string, cwd: string): void {
    const root = new RepoRootFinder().resolveRepoRoot(cwd);
    logGuardDecision(root, new GuardDecision('-', 'Bash', command, branchForLog(root), 'ALLOW', 'installer bypass (always allowed)'));
}

function runBashInternal(command: string, cwd: string, mode: HookMode): BlockedResult | null {
    if (isInstallerCommand(command)) {
        logInstallerBypass(command, cwd);
        return null;
    }

    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null) return new BlockedResult(CONFIG_MISSING_REPORT);

    const workspaceRoot = path.dirname(loaded.configPath);

    // WHICH TREE does this command act on? Not necessarily the shell's cwd — an agent working in a
    // linked worktree writes `cd <worktree> && …` because `cd` does not persist between tool calls.
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

    // Honour excludePaths.guards on the bash path too (not just Read/Edit): a command whose effective
    // cwd sits under an excluded tree (e.g. repositories/**) drops the whole guard set — matching how
    // runInternal/runRead treat file paths. The relative path is '' when there is no `cd` (root), which
    // matches no exclusion glob, so a plain command at the repo root is unaffected.
    const rules = filterByExcludedPaths(
        filterByMode(loadRules(loaded.rulesConfig, workspaceRoot), mode),
        path.relative(workspaceRoot, tree.effectiveCwd),
        loaded.excludePaths,
    );
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig);
    if (outOfSync) return outOfSync;

    const subdirBlock = gitFromSubdirBlock(command, tree);
    if (subdirBlock) return subdirBlock;

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
    logGuardDecision(tree.root, new GuardDecision(ruleNames, 'Bash', command, branchForLog(tree.root), 'BLOCK', 'bash-guard block'));
    const report = formatReport(commandLabel(command), groups, BASH_SUBJECT) + exemptTreesHint(groups, loaded.excludePaths.guards);
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
// webpieces-disable no-function-outside-class -- sibling of the module-scope runner helpers; the whole file is functions and a lone class here would break its shape
function exemptTreesHint(groups: readonly RuleGroup[], exemptGuards: readonly string[]): string {
    if (exemptGuards.length === 0) return '';
    if (!groups.some((g: RuleGroup): boolean => g.ruleName === 'pr-creation-or-push-guard')) return '';
    return `\n\nℹ️  Working in a nested repo under one of these exempt trees? cd into it first and run git/gh `
        + `normally there — the webpieces guards do NOT govern them (each is its own repo): ${exemptGuards.join(', ')}.`;
}

// The set of rule names explicitly present in webpieces.config.json (every key except rulesDir).
function configuredRuleNames(config: WebpiecesRulesConfig): ReadonlySet<string> {
    return new Set(Object.keys(config).filter((k: string) => k !== 'rulesDir'));
}

function checkConfigSync(rules: readonly Rule[], config: WebpiecesRulesConfig): BlockedResult | null {
    const configured = configuredRuleNames(config);
    const unconfiguredRules = rules.filter((r: Rule) => !configured.has(r.name));
    if (unconfiguredRules.length === 0) return null;

    const lines = [
        'webpieces.config.json is out of sync — new built-in rules are present that have no entry in webpieces.config.json.',
        '',
        'Tell the human: the following rules need to be configured. Ask for each one:',
        '  - Should this rule be ON, OFF, NEW_AND_MODIFIED_CODE, or NEW_AND_MODIFIED_FILES?',
        '  - What values do you want for the options listed below?',
        'Then update webpieces.config.json and retry.',
        '',
        'Do NOT proceed until webpieces.config.json has an entry for every rule below.',
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
        lines.push(`Example entry for webpieces.config.json:`);
        lines.push(`  "${rule.name}": { "mode": "ON" }`);
        lines.push('');
    }

    return new BlockedResult(lines.join('\n'));
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
