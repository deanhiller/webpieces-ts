// ResolvedConfig / ResolvedRuleConfig / RuleOptions now live in @webpieces/rules-config
// so ai-hooks and the Nx validate-code executor share one loader and one config file.
import { RuleOptions } from '@webpieces/rules-config';
export { ResolvedConfig, ResolvedRuleConfig, RuleOptions, InformAiError, RuleFailError } from '@webpieces/rules-config';
import { FixHint } from './fix-hint';

// 'Read' is a first-class member because read-stale-guard is a file-scoped guard that runs on the
// Read fast path. It is deliberately NOT in HANDLED_FILE_TOOLS (hook-core), so normalizeToolKind()
// still returns null for it and Read never enters the edit/file rule pipeline — only the one guard
// that asks for it. Nothing switches exhaustively on this union; it is carried for logging.
export type ToolKind = 'Write' | 'Edit' | 'MultiEdit' | 'Read';
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

    // A quoted span WITHOUT whitespace is kept: `git checkout "main"` is a real command with a quoted
    // argument, not prose. One containing whitespace is a sentence, and becomes a single space.
    private stripProse(command: string): string {
        const withoutHeredocs = command.replace(HEREDOC_BODY, ' ');
        return withoutHeredocs.replace(QUOTED_SPAN, (match: string, single?: string, double?: string): string => {
            const content = single ?? double ?? '';
            return /\s/.test(content) ? ' ' : content;
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

    constructor(report: string) {
        this.report = report;
    }
}

