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

export class BashContext {
    readonly tool: 'Bash';
    readonly command: string;
    readonly workspaceRoot: string;
    options: RuleOptions;

    constructor(command: string, workspaceRoot: string) {
        this.tool = 'Bash';
        this.command = command;
        this.workspaceRoot = workspaceRoot;
        this.options = {};
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

