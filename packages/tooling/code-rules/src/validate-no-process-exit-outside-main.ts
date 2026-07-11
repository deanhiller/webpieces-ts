/**
 * Validate No Process Exit Outside Main
 *
 * Flags `process.exit(...)` outside a `main()`/`runMain` wrapper, and `import { main }` from another
 * module. A `process.exit` deep in a reused call stack crashes a server or command far too early and
 * unexpectedly — and with exit 0 it masquerades as success. Throw a semantic error instead and let
 * the ONE top-level `main()`/`runMain` try-catch pick the exit code.
 *
 * See .webpieces/instruct-ai/webpieces.noexitinmain.md (generated on violation) for the full pattern.
 *
 * ALLOWED
 * - A `process.exit` whose nearest enclosing function is named `main` or `runMain`.
 * - Test files (*.test.ts, *.spec.ts, __tests__/**).
 * - Lines with `// webpieces-disable no-process-exit-outside-main -- <reason>` (when disableAllowed).
 *
 * MODES (LINE-BASED)
 * - OFF:                    Skip.
 * - NEW_AND_MODIFIED_CODE:  Flag only on changed lines (diff hunks).
 * - NEW_AND_MODIFIED_FILES: Flag every occurrence in any modified file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { hasDisable, RULE_NAMES, NoProcessExitOutsideMainConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers, writeTemplateIfMissing, RepoRootFinder } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

const INSTRUCT_FILE = 'webpieces.noexitinmain.md';
const EXIT_REGEX = /\bprocess\.exit\s*\(/;
const IMPORT_MAIN_REGEX = /^\s*import\b[^;]*\{[^}]*\bmain\b[^}]*\}[^;]*\bfrom\b/;
// Named function / arrow-const DEFINITION openers (never a call like `main()`), used to find the
// enclosing function's name via a backward scan.
const FUNC_DEF_REGEX = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/;
const ALLOWED_FN = new Set(['main', 'runMain']);

const SHARED_MESSAGE = `Do not call process.exit() deep in the stack — any code may be reused, and a deep exit crashes a
server or command far too early (exit 0 even masquerades as success). Throw a semantic error instead:
  - Expected/normal failure → your domain's failure error (in the rules engine: RuleFailError).
  - A bug / broken precondition (should-never-happen, missing required var) → an ordinary Error.
Let the ONE top-level main()/runMain try-catch pick the exit code (non-zero on failure, 0 on success):
  if (require.main === module) runMain(main)
Need a specific exit code deep down? throw new CliExitError(code, message) — runMain maps it.
Also: do NOT import another module's main — call a named function; only a thin wrapper calls main.
Last resort: append // webpieces-disable no-process-exit-outside-main -- <reason> at a genuine terminal boundary.`;

interface ExitViolation {
    file: string;
    line: number;
    context: string;
}

interface ExitViolationInfo {
    line: number;
    context: string;
    hasDisableComment: boolean;
}

function isTestFile(filePath: string): boolean {
    return filePath.includes('.spec.ts') || filePath.includes('.test.ts') || filePath.includes('__tests__/');
}

function stripLineComments(line: string): string {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    return line.substring(0, idx);
}

// Walk backward from `idx` for the nearest NAMED function/arrow definition and return its name.
// Line-based heuristic (no AST): recognises a `main`/`runMain` wrapper enclosing the exit.
function enclosingFunctionName(strippedLines: string[], idx: number): string | null {
    for (let j = idx; j >= 0; j -= 1) {
        const m = FUNC_DEF_REGEX.exec(strippedLines[j] ?? '');
        if (m) return m[1] ?? m[2] ?? null;
    }
    return null;
}

function resolveDisable(disabled: boolean, disableAllowed: boolean): boolean {
    if (!disableAllowed && disabled) return false;
    return disabled;
}

export function findExitViolationsInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean): ExitViolationInfo[] {
    if (isTestFile(filePath)) return [];
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const stripped = lines.map((l: string): string => stripLineComments(l));
    const violations: ExitViolationInfo[] = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const strippedLine = stripped[i] ?? '';
        const isExit = EXIT_REGEX.test(strippedLine) && !ALLOWED_FN.has(enclosingFunctionName(stripped, i) ?? '');
        const isImportMain = IMPORT_MAIN_REGEX.test(strippedLine);
        if (!isExit && !isImportMain) continue;

        const lineNum = i + 1;
        const prevLine = i > 0 ? (lines[i - 1] ?? '') : '';
        const disabled = hasDisable(line, RULE_NAMES.NO_PROCESS_EXIT_OUTSIDE_MAIN) || hasDisable(prevLine, RULE_NAMES.NO_PROCESS_EXIT_OUTSIDE_MAIN);
        violations.push({ line: lineNum, context: line.trim(), hasDisableComment: resolveDisable(disabled, disableAllowed) });
    }
    return violations;
}

function findViolationsForModifiedCode(workspaceRoot: string, changedFiles: string[], base: string, head: string | undefined, disableAllowed: boolean): ExitViolation[] {
    const violations: ExitViolation[] = [];
    for (const file of changedFiles) {
        const changedLines = getChangedLineNumbers(getFileDiff(workspaceRoot, file, base, head));
        if (changedLines.size === 0) continue;
        for (const v of findExitViolationsInFile(file, workspaceRoot, disableAllowed)) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;
            violations.push({ file, line: v.line, context: v.context });
        }
    }
    return violations;
}

function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): ExitViolation[] {
    const violations: ExitViolation[] = [];
    for (const file of changedFiles) {
        for (const v of findExitViolationsInFile(file, workspaceRoot, disableAllowed)) {
            if (disableAllowed && v.hasDisableComment) continue;
            violations.push({ file, line: v.line, context: v.context });
        }
    }
    return violations;
}

function reportViolations(workspaceRoot: string, violations: ExitViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
    writeTemplateIfMissing(workspaceRoot, INSTRUCT_FILE);
    console.error('');
    console.error('❌ process.exit() outside main()/runMain (or an import of another module\'s main)!');
    console.error('');
    console.error(SHARED_MESSAGE);
    console.error(`READ ${new RepoRootFinder().instructAiDocPath(workspaceRoot, INSTRUCT_FILE)} for the full pattern.`);
    console.error('');
    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     ${v.context}`);
    }
    console.error('');
    console.error(disableAllowed
        ? '   Escape hatch (genuine terminal boundary only): // webpieces-disable no-process-exit-outside-main -- <reason>'
        : '   Escape hatch: DISABLED (disableAllowed: false)');
    console.error(`\n   Current mode: ${mode}\n`);
}

function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') return normalMode;
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping no-process-exit-outside-main validation (${skip.reason})\n`);
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(options: NoProcessExitOutsideMainConfig, workspaceRoot: string): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping no-process-exit-outside-main validation (mode: OFF)\n');
        return { success: true };
    }

    console.log('\n📏 Validating No Process Exit Outside Main\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];
    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log('\n⏭️  Skipping no-process-exit-outside-main validation (could not detect base branch)\n');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}\n`);

    const changedFiles = getChangedFiles(workspaceRoot, base, head);
    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    let violations: ExitViolation[] = [];
    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('✅ No process.exit-outside-main violations found');
        return { success: true };
    }

    reportViolations(workspaceRoot, violations, mode, disableAllowed);
    return { success: false };
}

@provideSingleton()
@injectable()
export class NoProcessExitOutsideMainValidator extends CodeValidator<NoProcessExitOutsideMainConfig> {
    constructor(config: NoProcessExitOutsideMainConfig) {
        super(config, 'no-process-exit-outside-main');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
