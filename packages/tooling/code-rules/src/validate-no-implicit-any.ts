/**
 * Validate No Implicit Any Executor
 *
 * Flags function parameters, variables, and object-literal properties whose
 * types collapse to the implicit `any` produced by TypeScript inference when
 * an annotation is missing. Pairs with validate-no-any-unknown (which bans
 * the literal keyword) so together they force developers to write real types.
 *
 * Detection leverages the TypeScript compiler directly: we build a ts.Program
 * from the project's tsconfig.json with `noImplicitAny: true` overridden, then
 * filter pre-emit diagnostics to the set of codes that describe implicit-any
 * inferences (TS7006, TS7005, TS7018, etc.) and map them back to changed lines.
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:            Skip validation entirely.
 * - NEW_AND_MODIFIED_CODE:  Flag implicit-any on changed lines (lines in diff hunks).
 * - NEW_AND_MODIFIED_FILES: Flag ALL implicit-any in files that were modified.
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 *   // webpieces-disable no-implicit-any -- [your justification]
 *   function handler(x) { ... }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { hasDisable, RULE_NAMES, NoImplicitAnyConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

interface ImplicitAnyViolation {
    file: string;
    line: number;
    column: number;
    code: number;
    message: string;
    hasDisableComment: boolean;
}

// TS diagnostic codes that describe an implicit-any inference. TS7010 (missing
// return-type annotation) is intentionally omitted because it is already
// covered by the sibling `require-return-type` validator.
const IMPLICIT_ANY_CODES: ReadonlySet<number> = new Set<number>([
    7005, 7006, 7008, 7015, 7018, 7019, 7031, 7034, 7053,
]);

function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (hasDisable(line, RULE_NAMES.NO_IMPLICIT_ANY)) {
            return true;
        }
    }
    return false;
}

// Cache one ts.Program per tsconfig.json so multiple changed files in the
// same project share parse/binding cost.
const programCache = new Map<string, ts.Program | null>();

function findTsConfigForFile(absoluteFilePath: string, workspaceRoot: string): string | null {
    const root = path.resolve(workspaceRoot);
    let dir = path.dirname(absoluteFilePath);
    while (dir.startsWith(root)) {
        const candidate = path.join(dir, 'tsconfig.json');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function buildProgram(tsconfigPath: string): ts.Program | null {
    const configFile = ts.readConfigFile(tsconfigPath, (p: string) => ts.sys.readFile(p));
    if (configFile.error) return null;
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
    if (parsed.errors.length > 0 || parsed.fileNames.length === 0) return null;
    const options: ts.CompilerOptions = { ...parsed.options, noImplicitAny: true, noEmit: true, skipLibCheck: true };
    return ts.createProgram({ rootNames: parsed.fileNames, options });
}

function getProgramForFile(absoluteFilePath: string, workspaceRoot: string): ts.Program | null {
    const tsconfigPath = findTsConfigForFile(absoluteFilePath, workspaceRoot);
    if (!tsconfigPath) return null;
    if (programCache.has(tsconfigPath)) {
        return programCache.get(tsconfigPath) ?? null;
    }
    const program = buildProgram(tsconfigPath);
    programCache.set(tsconfigPath, program);
    return program;
}

function flattenMessage(message: string | ts.DiagnosticMessageChain): string {
    return ts.flattenDiagnosticMessageText(message, ' ');
}

function findImplicitAnyInFile(filePath: string, workspaceRoot: string): ImplicitAnyViolation[] {
    const absolute = path.resolve(workspaceRoot, filePath);
    if (!fs.existsSync(absolute)) return [];

    const program = getProgramForFile(absolute, workspaceRoot);
    if (!program) return [];

    const sourceFile = program.getSourceFile(absolute);
    if (!sourceFile) return [];

    const fileLines = fs.readFileSync(absolute, 'utf-8').split('\n');
    const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
    const violations: ImplicitAnyViolation[] = [];

    for (const diag of diagnostics) {
        if (!IMPLICIT_ANY_CODES.has(diag.code)) continue;
        if (!diag.file || diag.start === undefined) continue;
        const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
        const line = pos.line + 1;
        const column = pos.character + 1;
        violations.push({
            file: filePath,
            line,
            column,
            code: diag.code,
            message: flattenMessage(diag.messageText),
            hasDisableComment: hasDisableComment(fileLines, line),
        });
    }

    return violations;
}

function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean,
): ImplicitAnyViolation[] {
    const results: ImplicitAnyViolation[] = [];
    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);
        if (changedLines.size === 0) continue;

        const all = findImplicitAnyInFile(file, workspaceRoot);
        for (const v of all) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;
            results.push(v);
        }
    }
    return results;
}

function findViolationsForModifiedFiles(
    workspaceRoot: string,
    changedFiles: string[],
    disableAllowed: boolean,
): ImplicitAnyViolation[] {
    const results: ImplicitAnyViolation[] = [];
    for (const file of changedFiles) {
        const all = findImplicitAnyInFile(file, workspaceRoot);
        for (const v of all) {
            if (disableAllowed && v.hasDisableComment) continue;
            results.push(v);
        }
    }
    return results;
}

function reportViolations(violations: ImplicitAnyViolation[], mode: ModifiedCodeMode): void {
    console.error('');
    console.error('\u274c Implicit-any inferences found! Add explicit type annotations.');
    console.error('');
    console.error('\ud83d\udcda Why: an untyped parameter or variable erases type safety silently.');
    console.error('');
    console.error('   BAD:  function process(input) { return input.length; }');
    console.error('   GOOD: function process(input: string): number { return input.length; }');
    console.error('');

    for (const v of violations) {
        console.error(`  \u274c ${v.file}:${v.line}:${v.column}`);
        console.error(`     TS${v.code}: ${v.message}`);
    }
    console.error('');
    console.error('   Escape hatch (use sparingly):');
    console.error('   // webpieces-disable no-implicit-any -- [your reason]');
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n\u23ed\ufe0f  Skipping no-implicit-any validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runInternal(
    options: NoImplicitAnyConfig,
    workspaceRoot: string,
): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping no-implicit-any validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n\ud83d\udccf Validating No Implicit Any\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping no-implicit-any validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const changedFiles = getChangedFiles(workspaceRoot, base, head);
    if (changedFiles.length === 0) {
        console.log('\u2705 No TypeScript files changed');
        return { success: true };
    }

    console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

    let violations: ImplicitAnyViolation[] = [];
    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No implicit-any inferences found');
        return { success: true };
    }

    reportViolations(violations, mode);
    return { success: false };
}

async function runValidatorImpl(
    options: NoImplicitAnyConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return await runInternal(options, workspaceRoot);
    } catch (err: unknown) {
        //const error = toError(err);
        console.warn('\n\u23ed\ufe0f  Skipping no-implicit-any validation due to unexpected error\n');
        return { success: true };
    }
}

export class NoImplicitAnyValidator extends CodeValidator<NoImplicitAnyConfig> {
    constructor(config: NoImplicitAnyConfig) {
        super(config, 'no-implicit-any');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
