/**
 * Validate No Symbol DI Tokens Executor
 *
 * Validates that Symbol() / Symbol.for() are not used to create DI tokens
 * outside of the designated API-binding packages.
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * - export const MY_TOKEN = Symbol('MY_TOKEN')
 * - export const MY_TOKEN = Symbol.for('MY_TOKEN')
 * - const TOKEN: symbol = Symbol('TOKEN')
 *
 * ============================================================================
 * ALLOWED
 * ============================================================================
 *
 * - Files under allowedPaths (e.g. libraries/apis/**, libraries/apis-external/**)
 * - Test files (*.test.ts, *.spec.ts, __tests__/**)
 * - Lines with // webpieces-disable no-symbol-di-tokens -- <reason> (when disableAllowed: true)
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - MODIFIED_CODE:  Flag Symbol DI tokens on changed lines (lines in diff hunks)
 * - MODIFIED_FILES: Flag ALL Symbol DI tokens in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment on the same line or line above the violation:
 *   // webpieces-disable no-symbol-di-tokens -- [your justification]
 *   export const MY_TOKEN = Symbol('MY_TOKEN');
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { shouldSkipRule } from './resolve-mode';

export type NoSymbolDiTokensMode = 'OFF' | 'MODIFIED_CODE' | 'MODIFIED_FILES';

export interface ValidateNoSymbolDiTokensOptions {
    mode?: NoSymbolDiTokensMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
    allowedPaths?: string[];
}

export interface ExecutorResult {
    success: boolean;
}

const SYMBOL_DI_REGEX = /=\s*Symbol(?:\.for)?\(/;

const SHARED_MESSAGE = `Do not create a dependency-injection token with Symbol(). Symbol() for DI is allowed in ONLY two places:
  1. API definitions (libraries/apis/**)          — define the Symbol token alongside the API interface.
  2. Framework primitives (packages/http/http-api/**)
EVERYWHERE ELSE, choose the right pattern:
  A) OWN class: annotate it with @provideSingleton() and inject by concrete class TYPE — no Symbol, no @inject.
       constructor(private readonly myService: MyService) {}
  B) EXTERNAL library impl (libraries/apis-external/**): import the Symbol from libraries/apis/** and use:
       @provideSingletonAs(SOME_API_TOKEN)
       export class SomeApiImpl implements SomeApi { ... }
  C) EXTERNAL library class you cannot decorate (DataSource, Anthropic, etc.):
       bind in a ContainerModule using the class itself as token — no Symbol needed:
         bind<Anthropic>(Anthropic).toDynamicValue(() => new Anthropic({ apiKey: ... })).inSingletonScope()
       Then inject by type — no Symbol, no @inject.
If this specific line is a legitimate binding or framework primitive, append:  // webpieces-disable no-symbol-di-tokens -- <reason>`;

interface SymbolViolation {
    file: string;
    line: number;
    context: string;
}

interface SymbolViolationInfo {
    line: number;
    context: string;
    hasDisableComment: boolean;
}

function isTestFile(filePath: string): boolean {
    return filePath.includes('.spec.ts') ||
        filePath.includes('.test.ts') ||
        filePath.includes('__tests__/');
}

function globToRegex(pattern: string): RegExp {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
                if (pattern[i] === '/') i += 1;
                continue;
            }
            re += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            re += '[^/]';
            i += 1;
            continue;
        }
        if ('.+^$(){}|[]\\'.includes(ch)) {
            re += '\\' + ch;
            i += 1;
            continue;
        }
        re += ch;
        i += 1;
    }
    return new RegExp('^' + re + '$');
}

function isAllowedPath(filePath: string, allowedPaths: string[]): boolean {
    for (const pattern of allowedPaths) {
        if (globToRegex(pattern).test(filePath)) {
            return true;
        }
    }
    return false;
}

function stripLineComments(line: string): string {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    return line.substring(0, idx);
}

function hasDisableOnLine(line: string): boolean {
    return line.includes('webpieces-disable') && line.includes('no-symbol-di-tokens');
}

function resolveDisable(disabled: boolean, disableAllowed: boolean): boolean {
    if (!disableAllowed && disabled) {
        return false;
    }
    return disabled;
}

export function findSymbolViolationsInFile(
    filePath: string,
    workspaceRoot: string,
    disableAllowed: boolean,
    allowedPaths: string[],
): SymbolViolationInfo[] {
    if (isTestFile(filePath)) return [];
    if (isAllowedPath(filePath, allowedPaths)) return [];

    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const violations: SymbolViolationInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const stripped = stripLineComments(line);

        if (!SYMBOL_DI_REGEX.test(stripped)) continue;

        const lineNum = i + 1;
        const prevLine = i > 0 ? (lines[i - 1] ?? '') : '';
        const disabled = hasDisableOnLine(line) || hasDisableOnLine(prevLine);

        violations.push({
            line: lineNum,
            context: line.trim(),
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        });
    }

    return violations;
}

// webpieces-disable max-lines-new-methods -- Git command handling with untracked files requires multiple code paths
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f: string) => f && !isTestFile(f));

        if (!head) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const untrackedOutput = execSync(`git ls-files --others --exclude-standard '*.ts' '*.tsx'`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                });
                const untrackedFiles = untrackedOutput
                    .trim()
                    .split('\n')
                    .filter((f: string) => f && !isTestFile(f));
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
            } catch {
                return changedFiles;
            }
        }

        return changedFiles;
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
    } catch {
        return [];
    }
}

function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
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
                    const fileLines = content.split('\n');
                    return fileLines.map((line: string) => `+${line}`).join('\n');
                }
            }
        }

        return diff;
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
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

function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean,
    allowedPaths: string[],
): SymbolViolation[] {
    const violations: SymbolViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findSymbolViolationsInFile(file, workspaceRoot, disableAllowed, allowedPaths);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;

            violations.push({ file, line: v.line, context: v.context });
        }
    }

    return violations;
}

function findViolationsForModifiedFiles(
    workspaceRoot: string,
    changedFiles: string[],
    disableAllowed: boolean,
    allowedPaths: string[],
): SymbolViolation[] {
    const violations: SymbolViolation[] = [];

    for (const file of changedFiles) {
        const allViolations = findSymbolViolationsInFile(file, workspaceRoot, disableAllowed, allowedPaths);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            violations.push({ file, line: v.line, context: v.context });
        }
    }

    return violations;
}

function detectBase(workspaceRoot: string): string | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
    } catch {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (mergeBase) {
                return mergeBase;
            }
        // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
        } catch {
            // Ignore
        }
    }
    return null;
}

// webpieces-disable max-lines-new-methods -- Console output with guidance message and violation list
function reportViolations(violations: SymbolViolation[], mode: NoSymbolDiTokensMode, disableAllowed: boolean): void {
    console.error('');
    console.error('❌ Symbol() DI tokens are not allowed outside api(-external) packages!');
    console.error('');
    console.error(SHARED_MESSAGE);
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     ${v.context}`);
    }
    console.error('');

    if (disableAllowed) {
        console.error('   Escape hatch (use sparingly):');
        console.error('   // webpieces-disable no-symbol-di-tokens -- <reason>');
    } else {
        console.error('   Escape hatch: DISABLED (disableAllowed: false)');
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

function resolveMode(normalMode: NoSymbolDiTokensMode, epoch: number | undefined, branchPattern: string | undefined): NoSymbolDiTokensMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping no-symbol-di-tokens validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

export default async function runNoSymbolDiTokensExecutor(
    options: ValidateNoSymbolDiTokensOptions,
    workspaceRoot: string,
): Promise<ExecutorResult> {
    const mode: NoSymbolDiTokensMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;
    const allowedPaths = options.allowedPaths ?? [
        'libraries/apis/**',
        'packages/http/http-api/**',
    ];

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping no-symbol-di-tokens validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating No Symbol DI Tokens\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping no-symbol-di-tokens validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    let violations: SymbolViolation[] = [];

    if (mode === 'MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed, allowedPaths);
    } else if (mode === 'MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed, allowedPaths);
    }

    if (violations.length === 0) {
        console.log('✅ No Symbol DI token violations found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);

    return { success: false };
}
