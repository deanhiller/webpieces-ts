/**
 * Validate No Direct API in Resolver Executor
 *
 * Validates two Angular anti-patterns using LINE-BASED detection:
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * 1. In *.routes.ts files: inject(XxxApi) — resolvers should inject services, not APIs directly
 * 2. In *.component.ts files: this.<field>.snapshot.data — components should subscribe to
 *    service BehaviorSubjects, not read route snapshot data
 *
 * ============================================================================
 * CORRECT PATTERNS (GOOD)
 * ============================================================================
 *
 * 1. In resolvers: inject(XxxService) which calls the API internally
 * 2. In components: this.myService.someObservable$ (subscribe to service BehaviorSubjects)
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:                      Skip validation entirely
 * - MODIFIED_CODE:            Flag violations on changed lines (lines in diff hunks)
 * - NEW_AND_MODIFIED_METHODS: Flag violations in new/modified method/route scopes
 * - MODIFIED_FILES:           Flag ALL violations in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-direct-api-resolver -- [your justification]
 *   const myApi = inject(MyApi);
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { getFileDiff, getChangedLineNumbers, findNewMethodSignaturesInDiff } from './diff-utils';

export type NoDirectApiResolverMode = 'OFF' | 'MODIFIED_CODE' | 'NEW_AND_MODIFIED_METHODS' | 'MODIFIED_FILES';

export interface ValidateNoDirectApiResolverOptions {
    mode?: NoDirectApiResolverMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    enforcePaths?: string[];
}

export interface ExecutorResult {
    success: boolean;
}

interface Violation {
    file: string;
    line: number;
    column: number;
    context: string;
}

interface ViolationInfo {
    line: number;
    column: number;
    context: string;
    hasDisableComment: boolean;
}

/**
 * Get changed TypeScript files between base and head (or working tree if head not specified).
 */
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
            .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));

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
                    .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            } catch (err: unknown) {
                //const error = toError(err);
                return changedFiles;
            }
        }

        return changedFiles;
    } catch (err: unknown) {
        //const error = toError(err);
        return [];
    }
}

/**
 * Check if a line contains a webpieces-disable comment for no-direct-api-resolver.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('no-direct-api-resolver')) {
            return true;
        }
    }
    return false;
}

/**
 * Auto-detect the base branch by finding the merge-base with origin/main.
 */
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
    } catch (err: unknown) {
        //const error = toError(err);
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
        } catch (err2: unknown) {
            //const error2 = toError(err2);
            // Ignore
        }
    }
    return null;
}

/**
 * Find inject(XxxApi) calls in *.routes.ts files.
 * Flags any CallExpression where callee is `inject` and the first argument is an identifier ending with `Api`.
 */
function findDirectApiInjections(filePath: string, workspaceRoot: string, disableAllowed: boolean): ViolationInfo[] {
    if (!filePath.endsWith('.routes.ts')) return [];

    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: ViolationInfo[] = [];

    function visit(node: ts.Node): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                if (ts.isIdentifier(callee) && callee.text === 'inject') {
                    const firstArg = node.arguments[0];
                    if (firstArg && ts.isIdentifier(firstArg) && firstArg.text.endsWith('Api')) {
                        const startPos = node.getStart(sourceFile);
                        if (startPos >= 0) {
                            const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                            const line = pos.line + 1;
                            const column = pos.character + 1;
                            const disabled = hasDisableComment(fileLines, line);

                            if (!disableAllowed && disabled) {
                                violations.push({ line, column, context: `inject(${firstArg.text}) in route resolver`, hasDisableComment: false });
                            } else {
                                violations.push({ line, column, context: `inject(${firstArg.text}) in route resolver`, hasDisableComment: disabled });
                            }
                        }
                    }
                }
            }
        } catch (err: unknown) {
            //const error = toError(err);
            // Skip nodes that cause errors during analysis
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

/**
 * Find this.<field>.snapshot.data access patterns in *.component.ts files.
 * Flags PropertyAccessExpression chains: this.<anything>.snapshot.data
 */
function findSnapshotDataAccess(filePath: string, workspaceRoot: string, disableAllowed: boolean): ViolationInfo[] {
    if (!filePath.endsWith('.component.ts')) return [];

    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: ViolationInfo[] = [];

    function visit(node: ts.Node): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // Looking for: this.<field>.snapshot.data
            // AST shape: PropertyAccessExpression(.data) -> PropertyAccessExpression(.snapshot) -> PropertyAccessExpression(.<field>) -> this
            if (ts.isPropertyAccessExpression(node) && node.name.text === 'data') {
                const snapshotAccess = node.expression;
                if (ts.isPropertyAccessExpression(snapshotAccess) && snapshotAccess.name.text === 'snapshot') {
                    const fieldAccess = snapshotAccess.expression;
                    if (ts.isPropertyAccessExpression(fieldAccess)) {
                        const receiver = fieldAccess.expression;
                        if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
                            const fieldName = fieldAccess.name.text;
                            const startPos = node.getStart(sourceFile);
                            if (startPos >= 0) {
                                const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                                const line = pos.line + 1;
                                const column = pos.character + 1;
                                const disabled = hasDisableComment(fileLines, line);

                                if (!disableAllowed && disabled) {
                                    violations.push({ line, column, context: `this.${fieldName}.snapshot.data in component`, hasDisableComment: false });
                                } else {
                                    violations.push({ line, column, context: `this.${fieldName}.snapshot.data in component`, hasDisableComment: disabled });
                                }
                            }
                        }
                    }
                }
            }
        } catch (err: unknown) {
            //const error = toError(err);
            // Skip nodes that cause errors during analysis
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

/**
 * Find all violations in a file (both inject(Api) and snapshot.data patterns).
 */
function findViolationsInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean): ViolationInfo[] {
    const apiViolations = findDirectApiInjections(filePath, workspaceRoot, disableAllowed);
    const snapshotViolations = findSnapshotDataAccess(filePath, workspaceRoot, disableAllowed);
    return [...apiViolations, ...snapshotViolations];
}

/**
 * MODIFIED_CODE mode: Flag violations on changed lines in diff hunks.
 */
// webpieces-disable max-lines-new-methods -- File iteration with diff parsing and line filtering
function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean
): Violation[] {
    const violations: Violation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findViolationsInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            // LINE-BASED: Only include if the violation is on a changed line
            if (!changedLines.has(v.line)) continue;

            violations.push({
                file,
                line: v.line,
                column: v.column,
                context: v.context,
            });
        }
    }

    return violations;
}

/**
 * MODIFIED_FILES mode: Flag ALL violations in files that were modified.
 */
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): Violation[] {
    const violations: Violation[] = [];

    for (const file of changedFiles) {
        const allViolations = findViolationsInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;

            violations.push({
                file,
                line: v.line,
                column: v.column,
                context: v.context,
            });
        }
    }

    return violations;
}

interface RangeInfo {
    name: string;
    startLine: number;
    endLine: number;
}

/**
 * Find route object ranges in *.routes.ts files.
 * A route object is an ObjectLiteralExpression that contains (directly or in descendants)
 * a `resolve` property. Returns the line range of each such top-level route object.
 */
function findRouteObjectRanges(filePath: string, workspaceRoot: string): RangeInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const ranges: RangeInfo[] = [];

    function hasResolveProperty(node: ts.Node): boolean {
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'resolve') {
            return true;
        }
        let found = false;
        ts.forEachChild(node, (child) => {
            if (hasResolveProperty(child)) {
                found = true;
            }
        });
        return found;
    }

    function visitTopLevel(node: ts.Node): void {
        if (ts.isObjectLiteralExpression(node) && hasResolveProperty(node)) {
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            ranges.push({
                name: `route@${start.line + 1}`,
                startLine: start.line + 1,
                endLine: end.line + 1,
            });
            return;
        }
        ts.forEachChild(node, visitTopLevel);
    }

    visitTopLevel(sourceFile);
    return ranges;
}

/**
 * Find method/function ranges in *.component.ts files.
 * Returns ranges for class methods, function declarations, and arrow functions in variable declarations.
 */
function findMethodRanges(filePath: string, workspaceRoot: string): RangeInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const ranges: RangeInfo[] = [];

    function visit(node: ts.Node): void {
        let methodName: string | undefined;
        let startLine: number | undefined;
        let endLine: number | undefined;

        if (ts.isMethodDeclaration(node) && node.name) {
            methodName = node.name.getText(sourceFile);
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            startLine = start.line + 1;
            endLine = end.line + 1;
        } else if (ts.isFunctionDeclaration(node) && node.name) {
            methodName = node.name.getText(sourceFile);
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            startLine = start.line + 1;
            endLine = end.line + 1;
        } else if (ts.isArrowFunction(node)) {
            if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
                methodName = node.parent.name.getText(sourceFile);
                const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
                startLine = start.line + 1;
                endLine = end.line + 1;
            }
        }

        if (methodName && startLine !== undefined && endLine !== undefined) {
            ranges.push({ name: methodName, startLine, endLine });
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return ranges;
}

/**
 * NEW_AND_MODIFIED_METHODS mode: Flag violations in new/modified method/route scopes.
 * - For *.routes.ts: If any line in a route object is changed, flag all inject(XxxApi) violations in that route
 * - For *.component.ts: If a method is new/modified, flag all snapshot.data violations in that method
 */
// webpieces-disable max-lines-new-methods -- Method-scoped validation with route objects and component methods
function findViolationsForModifiedMethods(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean
): Violation[] {
    const violations: Violation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);

        if (changedLines.size === 0 && newMethodNames.size === 0) continue;

        if (file.endsWith('.routes.ts')) {
            const routeRanges = findRouteObjectRanges(file, workspaceRoot);
            const allViolations = findDirectApiInjections(file, workspaceRoot, disableAllowed);

            for (const range of routeRanges) {
                let rangeHasChanges = false;
                for (let line = range.startLine; line <= range.endLine; line++) {
                    if (changedLines.has(line)) {
                        rangeHasChanges = true;
                        break;
                    }
                }
                if (!rangeHasChanges) continue;

                for (const v of allViolations) {
                    if (disableAllowed && v.hasDisableComment) continue;
                    if (v.line >= range.startLine && v.line <= range.endLine) {
                        violations.push({
                            file,
                            line: v.line,
                            column: v.column,
                            context: v.context,
                        });
                    }
                }
            }
        } else if (file.endsWith('.component.ts')) {
            const methodRanges = findMethodRanges(file, workspaceRoot);
            const allViolations = findSnapshotDataAccess(file, workspaceRoot, disableAllowed);

            for (const range of methodRanges) {
                const isNewMethod = newMethodNames.has(range.name);
                let rangeHasChanges = false;
                if (!isNewMethod) {
                    for (let line = range.startLine; line <= range.endLine; line++) {
                        if (changedLines.has(line)) {
                            rangeHasChanges = true;
                            break;
                        }
                    }
                }
                if (!isNewMethod && !rangeHasChanges) continue;

                for (const v of allViolations) {
                    if (disableAllowed && v.hasDisableComment) continue;
                    if (v.line >= range.startLine && v.line <= range.endLine) {
                        violations.push({
                            file,
                            line: v.line,
                            column: v.column,
                            context: v.context,
                        });
                    }
                }
            }
        }
    }

    return violations;
}

/**
 * Report violations to console.
 */
// webpieces-disable max-lines-new-methods -- Console output with examples and escape hatch information
function reportViolations(violations: Violation[], mode: NoDirectApiResolverMode, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c Direct API usage in resolvers or snapshot.data in components found!');
    console.error('');
    console.error('\ud83d\udcda Resolvers should use services, and components should subscribe to service observables:');
    console.error('');
    console.error('   BAD (in *.routes.ts resolver):');
    console.error('     const myApi = inject(MyApi);');
    console.error('     resolve: () => inject(MyApi).fetchData()');
    console.error('');
    console.error('   GOOD (in *.routes.ts resolver):');
    console.error('     const myService = inject(MyService);');
    console.error('     resolve: () => inject(MyService).loadData()');
    console.error('');
    console.error('   BAD (in *.component.ts):');
    console.error('     const data = this.route.snapshot.data;');
    console.error('');
    console.error('   GOOD (in *.component.ts):');
    console.error('     this.myService.data$.subscribe(data => ...)');
    console.error('');

    for (const v of violations) {
        console.error(`  \u274c ${v.file}:${v.line}:${v.column}`);
        console.error(`     ${v.context}`);
    }
    console.error('');

    if (disableAllowed) {
        console.error('   Escape hatch (use sparingly):');
        console.error('   // webpieces-disable no-direct-api-resolver -- [your reason]');
    } else {
        console.error('   Escape hatch: DISABLED (disableAllowed: false)');
        console.error('   Disable comments are ignored. Fix the pattern directly.');
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

/**
 * Resolve mode considering ignoreModifiedUntilEpoch override.
 * When active, downgrades to OFF. When expired, logs a warning.
 */
function resolveMode(normalMode: NoDirectApiResolverMode, epoch: number | undefined): NoDirectApiResolverMode {
    if (epoch === undefined || normalMode === 'OFF') {
        return normalMode;
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
        console.log(`\n\u23ed\ufe0f  Skipping no-direct-api-resolver validation (ignoreModifiedUntilEpoch active, expires: ${expiresDate})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

/**
 * Filter changed files to only those under enforcePaths (if configured).
 */
function filterByEnforcePaths(changedFiles: string[], enforcePaths: string[] | undefined): string[] {
    if (!enforcePaths || enforcePaths.length === 0) {
        return changedFiles;
    }
    return changedFiles.filter((file) =>
        enforcePaths.some((prefix) => file.startsWith(prefix))
    );
}

/**
 * Filter to only relevant Angular files (*.routes.ts and *.component.ts).
 */
function filterRelevantFiles(changedFiles: string[]): string[] {
    return changedFiles.filter((file) =>
        file.endsWith('.routes.ts') || file.endsWith('.component.ts')
    );
}

export default async function runValidator(
    options: ValidateNoDirectApiResolverOptions,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const mode: NoDirectApiResolverMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping no-direct-api-resolver validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n\ud83d\udccf Validating No Direct API in Resolver\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping no-direct-api-resolver validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const allChangedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);
    const scopedFiles = filterByEnforcePaths(allChangedFiles, options.enforcePaths);
    const changedFiles = filterRelevantFiles(scopedFiles);

    if (changedFiles.length === 0) {
        console.log('\u2705 No relevant Angular files changed (*.routes.ts, *.component.ts)');
        return { success: true };
    }

    console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

    let violations: Violation[] = [];

    if (mode === 'MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_METHODS') {
        violations = findViolationsForModifiedMethods(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No direct API resolver patterns found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);

    return { success: false };
}
