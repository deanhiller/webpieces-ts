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
 * - MODIFIED_CODE:  Flag implicit-any on changed lines (lines in diff hunks).
 * - MODIFIED_FILES: Flag ALL implicit-any in files that were modified.
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 *   // webpieces-disable no-implicit-any -- [your justification]
 *   function handler(x) { ... }
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type NoImplicitAnyMode = 'OFF' | 'MODIFIED_CODE' | 'MODIFIED_FILES';

export interface ValidateNoImplicitAnyOptions {
    mode?: NoImplicitAnyMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface ExecutorResult {
    success: boolean;
}

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

// webpieces-disable no-unmanaged-exceptions -- git CLI is a system boundary
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
    // webpieces-disable no-unmanaged-exceptions -- external command, errors are expected
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));

        if (!head) {
            // webpieces-disable no-unmanaged-exceptions -- external command
            try {
                const untrackedOutput = execSync(`git ls-files --others --exclude-standard '*.ts' '*.tsx'`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                });
                const untrackedFiles = untrackedOutput
                    .trim()
                    .split('\n')
                    .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
                // webpieces-disable catch-error-pattern -- git failure is discarded, returning best-known list
            } catch {
                return changedFiles;
            }
        }

        return changedFiles;
        // webpieces-disable catch-error-pattern -- git failure is discarded
    } catch {
        return [];
    }
}

// webpieces-disable no-unmanaged-exceptions -- git CLI is a system boundary
function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
    // webpieces-disable no-unmanaged-exceptions -- external command
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const diff = execSync(`git diff ${diffTarget} -- "${file}"`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });

        if (!diff && !head) {
            const fullPath = path.join(workspaceRoot, file);
            if (fs.existsSync(fullPath)) {
                const isUntracked = execSync(`git ls-files --others --exclude-standard "${file}"`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                }).trim();
                if (isUntracked) {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const lines = content.split('\n');
                    return lines.map((line) => `+${line}`).join('\n');
                }
            }
        }

        return diff;
        // webpieces-disable catch-error-pattern -- git failure is discarded, empty diff is fine
    } catch {
        return '';
    }
}

function getChangedLineNumbers(diffContent: string): Set<number> {
    const changedLines = new Set<number>();
    const lines = diffContent.split('\n');
    let currentLine = 0;

    for (const line of lines) {
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            currentLine = parseInt(hunkMatch[1], 10);
            continue;
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
            changedLines.add(currentLine);
            currentLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            // Deletions don't increment line number
        } else {
            currentLine++;
        }
    }

    return changedLines;
}

function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('no-implicit-any')) {
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
    const configFile = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
    if (configFile.error) return null;
    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
    );
    if (parsed.errors.length > 0) return null;
    if (parsed.fileNames.length === 0) return null;

    const options: ts.CompilerOptions = {
        ...parsed.options,
        noImplicitAny: true,
        noEmit: true,
        skipLibCheck: true,
    };

    // webpieces-disable no-unmanaged-exceptions -- ts.createProgram can throw on malformed configs; skip such projects
    // webpieces-disable catch-error-pattern -- malformed tsconfig is a skip, not an error to log
    try {
        return ts.createProgram({ rootNames: parsed.fileNames, options });
    } catch {
        return null;
    }
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

// webpieces-disable no-unmanaged-exceptions -- git CLI is a system boundary
function detectBase(workspaceRoot: string): string | null {
    // webpieces-disable no-unmanaged-exceptions -- external command
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (mergeBase) return mergeBase;
        // webpieces-disable catch-error-pattern -- fall through to origin/main-less fallback
    } catch {
        // webpieces-disable no-unmanaged-exceptions -- external command
        // webpieces-disable catch-error-pattern -- fall through to origin/main-less fallback
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            if (mergeBase) return mergeBase;
            // webpieces-disable catch-error-pattern -- ultimate fallback, return null below
        } catch {
            // fall through
        }
    }
    return null;
}

function reportViolations(violations: ImplicitAnyViolation[], mode: NoImplicitAnyMode): void {
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

function resolveMode(normalMode: NoImplicitAnyMode, epoch: number | undefined): NoImplicitAnyMode {
    if (epoch === undefined || normalMode === 'OFF') {
        return normalMode;
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
        console.log(`\n\u23ed\ufe0f  Skipping no-implicit-any validation (ignoreModifiedUntilEpoch active, expires: ${expiresDate})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

export default async function runExecutor(
    options: ValidateNoImplicitAnyOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: NoImplicitAnyMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch);
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

    const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);
    if (changedFiles.length === 0) {
        console.log('\u2705 No TypeScript files changed');
        return { success: true };
    }

    console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

    let violations: ImplicitAnyViolation[] = [];
    if (mode === 'MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No implicit-any inferences found');
        return { success: true };
    }

    reportViolations(violations, mode);
    return { success: false };
}
