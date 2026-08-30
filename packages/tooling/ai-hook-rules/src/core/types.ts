// ResolvedConfig / ResolvedRuleConfig / RuleOptions now live in @webpieces/rules-config
// so ai-hooks and the Nx validate-code executor share one loader and one config file.
import { RuleOptions } from '@webpieces/rules-config';
export { ResolvedConfig, ResolvedRuleConfig, RuleOptions, InformAiError, RuleFailError } from '@webpieces/rules-config';
import { FixHint } from './fix-hint';
import { L0_FAULT_NONE } from './l0-fault-codes';

// 'Read' is a first-class member because read-stale-guard is a file-scoped guard that runs on the
// Read fast path. It is deliberately NOT in HANDLED_FILE_TOOLS (hook-core), so normalizeToolKind()
// still returns null for it and Read never enters the edit/file rule pipeline — only the one guard
// that asks for it. Nothing switches exhaustively on this union; it is carried for logging.
//
// 'Delete' arrives ONLY from a Codex `apply_patch` carrying a `*** Delete File:` directive — no Claude
// Code tool produces it. Every existing rule DEFAULTS TO NOT FIRING on it (see DELETE_SCOPED_RULES in
// runner.ts): a rule written to judge the bytes an edit ADDS has nothing to say about a file going
// away, and inventing a verdict for it would be guessing. Rules for which a delete IS meaningful — a
// barrel export disappearing, a doc that documents a deleted file — opt in there, deliberately.
export type ToolKind = 'Write' | 'Edit' | 'MultiEdit' | 'Read' | 'Delete';
export type RuleScope = 'edit' | 'file' | 'bash';
// Which category of built-in rules a hook invocation runs: code-style 'rules', git/PR/branch
// 'guards' (the hookGuards section), or 'all' (both categories — used by the openclaw plugin adapter,
// which is a single before_tool_call hook rather than two split PreToolUse hooks).
export type HookMode = 'rules' | 'guards' | 'all';
export type IsLineDisabled = (lineNum: number, ruleName: string) => boolean;

export class Violation {
    readonly line: number;
    readonly snippet: string;
    // Optional per-occurrence override for the `→` line. When omitted, the report falls back
    // to the rule's `FixHint.violation`. Dynamic rules (param name, line count, marker path,
    // branch/PR) pass a specific message here; static rules omit it.
    readonly message: string | undefined;
    editIndex: number | undefined;
    editCount: number | undefined;

    constructor(line: number, snippet: string, message?: string) {
        this.line = line;
        this.snippet = snippet;
        this.message = message;
        this.editIndex = undefined;
        this.editCount = undefined;
    }
}

export class NormalizedEdit {
    readonly oldString: string;
    readonly newString: string;

    constructor(oldString: string, newString: string) {
        this.oldString = oldString;
        this.newString = newString;
    }
}

export class NormalizedToolInput {
    readonly filePath: string;
    readonly edits: readonly NormalizedEdit[];

    constructor(filePath: string, edits: readonly NormalizedEdit[]) {
        this.filePath = filePath;
        this.edits = edits;
    }
}

export class NormalizedBashInput {
    readonly command: string;

    constructor(command: string) {
        this.command = command;
    }
}

export class EditContext {
    readonly tool: ToolKind;
    readonly editIndex: number;
    readonly editCount: number;
    readonly filePath: string;
    readonly relativePath: string;
    readonly workspaceRoot: string;
    readonly addedContent: string;
    readonly strippedContent: string;
    readonly lines: readonly string[];
    readonly strippedLines: readonly string[];
    readonly removedContent: string;
    readonly isLineDisabled: IsLineDisabled;
    options: RuleOptions;

    constructor(
        tool: ToolKind,
        editIndex: number,
        editCount: number,
        filePath: string,
        relativePath: string,
        workspaceRoot: string,
        addedContent: string,
        strippedContent: string,
        lines: readonly string[],
        strippedLines: readonly string[],
        removedContent: string,
        isLineDisabled: IsLineDisabled,
    ) {
        this.tool = tool;
        this.editIndex = editIndex;
        this.editCount = editCount;
        this.filePath = filePath;
        this.relativePath = relativePath;
        this.workspaceRoot = workspaceRoot;
        this.addedContent = addedContent;
        this.strippedContent = strippedContent;
        this.lines = lines;
        this.strippedLines = strippedLines;
        this.removedContent = removedContent;
        this.isLineDisabled = isLineDisabled;
        this.options = {};
    }
}

// A heredoc and its body: `<<EOF` / `<<'EOF'` / `<<-EOF` through the terminator line.
const HEREDOC_BODY = /<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\t*\2\s*$/gm;

// A single- or double-quoted span.
const QUOTED_SPAN = /'([^']*)'|"([^"]*)"/g;

// Shell syntax that a quoted span is explicitly NOT: separators, pipes, subshells, redirection,
// expansion. Content carrying any of these is data (a jq filter, a regex, a glob), and unquoting it
// would hand the segment scanner syntax the shell never sees. See stripProse.
const SHELL_METACHARACTER = /[|;&()<>$`]/;

export class BashContext {
    readonly tool: 'Bash';
    readonly command: string;
    /**
     * `command` with heredoc bodies and prose-in-quotes removed — what a guard should MATCH on, while
     * `command` stays raw for the violation message (a human needs to see what they actually typed).
     *
     * A commit message that merely MENTIONS a blocked command is not that command. This repo's whole
     * subject matter is the git workflow, so its commit messages, docs and the guards' own fix-hint
     * text are full of `git push` / `gh pr …` strings; matching raw text blocks writing about the
     * tooling. A guard that cries wolf is a guard someone eventually turns OFF, which costs far more
     * than the theoretical bypass this opens (`sh -c '<blocked command>'` stops matching). That trade
     * is deliberate: these guards exist to catch a FORGETFUL agent, not an adversarial one.
     *
     * ONLY for blocklist-shaped guards ("if the command matches X, block"), where stripping can only
     * ever block LESS. Never use it in an allowlist-shaped guard such as merged-branch-bash-guard,
     * where stripping could turn a permitted recovery command into a blocked one and deadlock the
     * session — there, match on the raw `command`.
     */
    readonly commandCode: string;
    /**
     * The tree this command is JUDGED against — the root of the worktree it actually acts on, which
     * is NOT the shell's cwd whenever the command carries a leading `cd <path> &&` (see
     * EffectiveTreeResolver). Guards read git state, the main-sync cache and the decision log from
     * here, so a command aimed at a linked worktree is judged on that worktree's branch, never the
     * primary clone's.
     */
    readonly workspaceRoot: string;
    /** The directory the command really runs in (post-`cd`). Relative paths resolve against THIS. */
    readonly effectiveCwd: string;
    /** The root owning webpieces.config.json. Equals workspaceRoot except in a linked worktree. */
    readonly governedRoot: string;
    options: RuleOptions;

    constructor(command: string, workspaceRoot: string, effectiveCwd?: string, governedRoot?: string) {
        this.tool = 'Bash';
        this.command = command;
        this.commandCode = this.stripProse(command);
        this.workspaceRoot = workspaceRoot;
        this.effectiveCwd = effectiveCwd ?? workspaceRoot;
        this.governedRoot = governedRoot ?? workspaceRoot;
        this.options = {};
    }

    /**
     * A quoted span WITHOUT whitespace is kept: `git checkout "main"` is a real command with a quoted
     * argument, not prose. One containing whitespace is a sentence, and becomes a single space.
     *
     * ONE exception, and it is a false positive that actually fired: a whitespace-free span carrying
     * SHELL METACHARACTERS is dropped too. Keeping the content strips only the quotes, so a jq filter —
     * `--jq '[.[]|select(.title|test("x"))]|length'` — was handed to the guards as bare shell syntax.
     * Every guard then split it on its `|`, `(` and `;` and saw a segment reading exactly `test`, which
     * whole-repo-build-guard classified as the workspace-wide test script and BLOCKED. There was no
     * build anywhere in that command; it polled npm and GitHub.
     *
     * Quoting is precisely how a shell says "this is DATA, not syntax", so honouring the quotes is the
     * correct reading. And because commandCode only ever feeds blocklist-shaped guards, dropping more
     * can only ever block LESS — never turn an allowed command into a refused one.
     */
    private stripProse(command: string): string {
        const withoutHeredocs = command.replace(HEREDOC_BODY, ' ');
        return withoutHeredocs.replace(QUOTED_SPAN, (match: string, single?: string, double?: string): string => {
            const content = single ?? double ?? '';
            if (/\s/.test(content)) return ' ';
            return SHELL_METACHARACTER.test(content) ? ' ' : content;
        });
    }
}

export class FileContext {
    readonly tool: ToolKind;
    readonly filePath: string;
    readonly relativePath: string;
    readonly workspaceRoot: string;
    readonly currentFileLines: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    readonly projectedFileLines: number;
    options: RuleOptions;

    constructor(
        tool: ToolKind,
        filePath: string,
        relativePath: string,
        workspaceRoot: string,
        currentFileLines: number,
        linesAdded: number,
        linesRemoved: number,
        projectedFileLines: number,
    ) {
        this.tool = tool;
        this.filePath = filePath;
        this.relativePath = relativePath;
        this.workspaceRoot = workspaceRoot;
        this.currentFileLines = currentFileLines;
        this.linesAdded = linesAdded;
        this.linesRemoved = linesRemoved;
        this.projectedFileLines = projectedFileLines;
        this.options = {};
    }
}

/**
 * The shape of a custom rule loaded from a `rulesDir` (a plain object returned by require()).
 * It carries only metadata + a `check` method — no on/off logic of its own.
 */
export interface PlainRule {
    readonly name: string;
    readonly description: string;
    readonly scope: RuleScope;
    readonly files: readonly string[];
    readonly defaultOptions: RuleOptions;
    readonly fixHint: FixHint;
    check(ctx: EditContext | FileContext | BashContext): readonly Violation[];
}

/**
 * The runtime contract the runner iterates. Both the built-in rule classes (which extend
 * EditRuleBase/FileRuleBase/BashRuleBase) and the custom-rule adapter satisfy this: they add
 * `shouldRun()` (mode + escape-hatch decision) on top of the PlainRule metadata.
 */
export interface Rule extends PlainRule {
    /**
     * The webpieces.config.json key whose entry configures this rule — NOT necessarily `name`.
     *
     * `name` is the operator identity (what a decision-log line and a deny report carry); `configKey`
     * is the switch. They differ wherever several classes implement one POLICY: all four branch-state
     * guards read `branch-state-guard`, all four PR-lifecycle guards read `pr-lifecycle-guard`. Every
     * consumer that asks "which section does this live in?" (filterByMode) or "does this have an
     * entry?" (the fault-Y config-sync check) must read THIS field, because asking for `name` there
     * demands entries under keys the validator rejects as retired.
     */
    readonly configKey: string;
    shouldRun(): boolean;
}

export class RuleGroup {
    readonly ruleName: string;
    readonly ruleDescription: string;
    readonly fixHint: FixHint;
    readonly violations: readonly Violation[];

    constructor(
        ruleName: string,
        ruleDescription: string,
        fixHint: FixHint,
        violations: readonly Violation[],
    ) {
        this.ruleName = ruleName;
        this.ruleDescription = ruleDescription;
        this.fixHint = fixHint;
        this.violations = violations;
    }
}

export class BlockedResult {
    readonly report: string;
    /**
     * The L0 fault this block IS, in the codebook's own letter (see core/l0-fault-codes.ts), or `-` for
     * an ordinary rule block.
     *
     * It rides on the result rather than being re-derived from the report text because the block is
     * decided deep in the runner (fault C in configMissingBlock, fault Y in checkConfigSync) and
     * STAMPED by the adapter at the terminal boundary, several frames up. Scraping the report for a
     * fault would be a second answer to a question the producer already knows.
     */
    readonly fault: string;

    constructor(report: string, fault: string = L0_FAULT_NONE) {
        this.report = report;
        this.fault = fault;
    }
}

