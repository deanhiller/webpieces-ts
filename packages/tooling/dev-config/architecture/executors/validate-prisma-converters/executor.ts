/**
 * Validate Prisma Converters Executor
 *
 * Validates that Prisma converter methods follow a scalable pattern:
 * methods returning XxxDto (where XxxDbo exists in schema.prisma) must
 * accept that exact XxxDbo as the first parameter. This keeps single-table
 * converters clean and forces join converters to compose them.
 *
 * ============================================================================
 * RULES
 * ============================================================================
 *
 * 1. First param must be exact Dbo:
 *    If method returns XxxDto and XxxDbo exists in schema.prisma,
 *    the first parameter must be of type XxxDbo.
 *
 * 2. Extra params must be booleans:
 *    Additional parameters beyond the Dbo are allowed but must be boolean
 *    (used for filtering payloads / security info).
 *
 * 3. No async converters:
 *    Methods returning Promise<XxxDto> are flagged — converters should be
 *    pure data mapping, no async work.
 *
 * 4. No standalone functions:
 *    Standalone functions in converter files are flagged — must be class
 *    methods so the converter class can be injected (dependency tree tracing).
 *
 * 5. Dto creation outside converters directory:
 *    Files outside the configured convertersPath that create `new XxxDto(...)`
 *    where XxxDbo exists in schema.prisma are flagged — Dto instances tied to
 *    a Dbo must only be created via a converter class.
 *
 * ============================================================================
 * SKIP CONDITIONS
 * ============================================================================
 * - Methods with @deprecated decorator or JSDoc tag
 * - Lines with: // webpieces-disable prisma-converter -- [reason]
 *
 * ============================================================================
 * MODES
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - MODIFIED_FILES: Validate converter files that were modified in the diff
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type PrismaConverterMode = 'OFF' | 'MODIFIED_FILES';

export interface ValidatePrismaConvertersOptions {
    mode?: PrismaConverterMode;
    schemaPath?: string;
    convertersPaths?: string[];
}

export interface ExecutorResult {
    success: boolean;
}

interface PrismaConverterViolation {
    file: string;
    line: number;
    message: string;
}

interface UnwrapResult {
    inner: string;
    isAsync: boolean;
}

interface FileContext {
    filePath: string;
    fileLines: string[];
    sourceFile: ts.SourceFile;
    prismaModels: Set<string>;
}

/**
 * Auto-detect the base branch by finding the merge-base with origin/main.
 */
function detectBase(workspaceRoot: string): string | null {
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    } catch {
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (mergeBase) {
                return mergeBase;
            }
        } catch {
            // Ignore
        }
    }
    return null;
}

/**
 * Get changed TypeScript files between base and head (or working tree if head not specified).
 */
// webpieces-disable max-lines-new-methods -- Git command handling with untracked files requires multiple code paths
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
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
            } catch {
                return changedFiles;
            }
        }

        return changedFiles;
    } catch {
        return [];
    }
}

/**
 * Parse schema.prisma to extract all model names into a Set.
 */
function parsePrismaModels(schemaPath: string): Set<string> {
    const models = new Set<string>();

    if (!fs.existsSync(schemaPath)) {
        return models;
    }

    const content = fs.readFileSync(schemaPath, 'utf-8');
    const regex = /^model\s+(\w+)\s*\{/gm;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        models.add(match[1]);
    }

    return models;
}

/**
 * Derive the expected Dbo name from a return type ending in Dto.
 * "XxxDto" -> "XxxDbo". Returns null if name doesn't end with Dto.
 */
function deriveExpectedDboName(returnType: string): string | null {
    if (!returnType.endsWith('Dto')) return null;
    return returnType.slice(0, -3) + 'Dbo';
}

/**
 * Check if a line has a webpieces-disable comment for prisma-converter.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('prisma-converter')) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a method/function node has a @deprecated decorator.
 */
function hasDeprecatedDecorator(node: ts.MethodDeclaration | ts.FunctionDeclaration): boolean {
    const modifiers = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (!modifiers) return false;

    for (const decorator of modifiers) {
        const expr = decorator.expression;
        // @deprecated or @deprecated()
        if (ts.isIdentifier(expr) && expr.text === 'deprecated') return true;
        if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'deprecated') {
            return true;
        }
    }
    return false;
}

/**
 * Check if a node has @deprecated in its JSDoc comments.
 */
function hasDeprecatedJsDoc(node: ts.Node): boolean {
    const jsDocs = ts.getJSDocTags(node);
    for (const tag of jsDocs) {
        if (tag.tagName.text === 'deprecated') return true;
    }
    return false;
}

/**
 * Check if a method is deprecated via decorator or JSDoc.
 */
function isDeprecated(node: ts.MethodDeclaration | ts.FunctionDeclaration): boolean {
    return hasDeprecatedDecorator(node) || hasDeprecatedJsDoc(node);
}

/**
 * Extract the text of a type node, stripping whitespace.
 */
function getTypeText(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): string {
    return typeNode.getText(sourceFile).trim();
}

/**
 * Unwrap Promise<T> to get T. Returns the inner type text if wrapped, otherwise returns as-is.
 */
function unwrapPromise(typeText: string): UnwrapResult {
    const promiseMatch = typeText.match(/^Promise\s*<\s*(.+)\s*>$/);
    if (promiseMatch) {
        return { inner: promiseMatch[1].trim(), isAsync: true };
    }
    return { inner: typeText, isAsync: false };
}

/**
 * Check a standalone function declaration in a converter file and return a violation if applicable.
 */
function checkStandaloneFunction(
    node: ts.FunctionDeclaration,
    ctx: FileContext
): PrismaConverterViolation | null {
    if (!node.name) return null;

    const startPos = node.getStart(ctx.sourceFile);
    const pos = ctx.sourceFile.getLineAndCharacterOfPosition(startPos);
    const line = pos.line + 1;

    if (hasDisableComment(ctx.fileLines, line) || isDeprecated(node)) return null;

    return {
        file: ctx.filePath,
        line,
        message: `Standalone function "${node.name.text}" found in converter file. ` +
            'Move to a converter class so it can be injected via DI.',
    };
}

/**
 * Validate the parameters of a converter method that returns a Dto with a matching Dbo.
 */
function checkMethodParams(
    node: ts.MethodDeclaration,
    innerType: string,
    expectedDbo: string,
    ctx: FileContext,
    line: number
): PrismaConverterViolation[] {
    const violations: PrismaConverterViolation[] = [];
    const params = node.parameters;

    if (params.length === 0) {
        violations.push({
            file: ctx.filePath,
            line,
            message: `Method returns "${innerType}" but has no parameters. ` +
                `First parameter must be of type "${expectedDbo}".`,
        });
        return violations;
    }

    const firstParam = params[0];
    if (firstParam.type) {
        const firstParamType = getTypeText(firstParam.type, ctx.sourceFile);
        if (firstParamType !== expectedDbo) {
            violations.push({
                file: ctx.filePath,
                line,
                message: `Method returns "${innerType}" but first parameter is "${firstParamType}". ` +
                    `First parameter must be of type "${expectedDbo}".`,
            });
        }
    }

    for (let i = 1; i < params.length; i++) {
        const param = params[i];
        if (param.type) {
            const paramType = getTypeText(param.type, ctx.sourceFile);
            if (paramType !== 'boolean') {
                const paramName = param.name.getText(ctx.sourceFile);
                violations.push({
                    file: ctx.filePath,
                    line,
                    message: `Extra parameter "${paramName}" has type "${paramType}" but must be "boolean". ` +
                        'Additional converter parameters are only for boolean flags (payload filtering / security).',
                });
            }
        }
    }

    return violations;
}

/**
 * Check a class method declaration for converter pattern violations.
 */
function checkConverterMethod(
    node: ts.MethodDeclaration,
    ctx: FileContext
): PrismaConverterViolation[] {
    if (!node.name || !node.type) return [];

    const startPos = node.getStart(ctx.sourceFile);
    const pos = ctx.sourceFile.getLineAndCharacterOfPosition(startPos);
    const line = pos.line + 1;

    if (hasDisableComment(ctx.fileLines, line) || isDeprecated(node)) return [];

    const returnTypeText = getTypeText(node.type, ctx.sourceFile);
    const { inner: innerType, isAsync } = unwrapPromise(returnTypeText);
    const expectedDbo = deriveExpectedDboName(innerType);

    if (!expectedDbo || !ctx.prismaModels.has(expectedDbo)) return [];

    if (isAsync) {
        return [{
            file: ctx.filePath,
            line,
            message: `Async converter method returning "Promise<${innerType}>" found. ` +
                'Converters should be pure data mapping with no async work. Remove async/Promise.',
        }];
    }

    return checkMethodParams(node, innerType, expectedDbo, ctx, line);
}

/**
 * Find converter method violations in a single file.
 * Checks class methods for proper Dbo parameter patterns and flags standalone functions.
 */
function findConverterViolationsInFile(
    filePath: string,
    workspaceRoot: string,
    prismaModels: Set<string>
): PrismaConverterViolation[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const ctx: FileContext = {
        filePath,
        fileLines: content.split('\n'),
        sourceFile: ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true),
        prismaModels,
    };

    const violations: PrismaConverterViolation[] = [];

    function visitNode(node: ts.Node): void {
        if (ts.isFunctionDeclaration(node)) {
            const violation = checkStandaloneFunction(node, ctx);
            if (violation) violations.push(violation);
        }

        if (ts.isMethodDeclaration(node)) {
            violations.push(...checkConverterMethod(node, ctx));
        }

        ts.forEachChild(node, visitNode);
    }

    visitNode(ctx.sourceFile);
    return violations;
}

/**
 * Find violations in non-converter files: creating `new XxxDto(...)` where XxxDbo exists in prisma.
 * These Dto instances must only be created inside converter classes.
 */
// webpieces-disable max-lines-new-methods -- AST traversal for new-expression detection with prisma model matching
function findDtoCreationOutsideConverters(
    filePath: string,
    workspaceRoot: string,
    prismaModels: Set<string>,
    convertersPaths: string[]
): PrismaConverterViolation[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: PrismaConverterViolation[] = [];

    function visitNode(node: ts.Node): void {
        // Detect `new XxxDto(...)` expressions
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            const className = node.expression.text;
            const expectedDbo = deriveExpectedDboName(className);

            if (expectedDbo && prismaModels.has(expectedDbo)) {
                const startPos = node.getStart(sourceFile);
                const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                const line = pos.line + 1;

                if (!hasDisableComment(fileLines, line)) {
                    const dirs = convertersPaths.map((p) => `"${p}"`).join(', ');
                    violations.push({
                        file: filePath,
                        line,
                        message: `"${className}" can only be created from its Dbo using a converter in one of these directories: ${dirs}. ` +
                            'Move this Dto construction into a converter class method.',
                    });
                }
            }
        }

        ts.forEachChild(node, visitNode);
    }

    visitNode(sourceFile);
    return violations;
}

/**
 * Report violations to console.
 */
function reportViolations(violations: PrismaConverterViolation[], mode: PrismaConverterMode): void {
    console.error('');
    console.error('❌ Prisma converter violations found!');
    console.error('');
    console.error('📚 Converter methods returning XxxDto (where XxxDbo exists in schema.prisma)');
    console.error('   must accept XxxDbo as the first parameter. This keeps single-table');
    console.error('   converters clean and forces join converters to compose them.');
    console.error('');
    console.error('   GOOD: convertUserDbo(userDbo: UserDbo): UserDto { }');
    console.error('   GOOD: convertVersionDbo(version: VersionDbo, partial?: boolean): VersionDto { }');
    console.error('   GOOD: convertToJoinDto(item: SomeJoinType): CourseJoinDto { }  // no matching JoinDbo');
    console.error('');
    console.error('   BAD:  async convertUser(dbo: UserDbo): Promise<UserDto> { }    // no async');
    console.error('   BAD:  convertCourse(course: CourseWithMeta): CourseDto { }      // wrong first param');
    console.error('   BAD:  convertUser(dbo: UserDbo, name: string): UserDto { }      // extra non-boolean');
    console.error('   BAD:  export function convertSession(s: SessionDbo): SessionDto // standalone function');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     ${v.message}`);
    }
    console.error('');

    console.error('   Escape hatch (use sparingly):');
    console.error('   // webpieces-disable prisma-converter -- [your reason]');
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

export default async function runExecutor(
    options: ValidatePrismaConvertersOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: PrismaConverterMode = options.mode ?? 'OFF';

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping prisma-converter validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    const schemaPath = options.schemaPath;
    const convertersPaths = options.convertersPaths ?? [];

    if (!schemaPath || convertersPaths.length === 0) {
        const reason = !schemaPath ? 'no schemaPath configured' : 'no convertersPaths configured';
        console.log(`\n⏭️  Skipping prisma-converter validation (${reason})`);
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating Prisma Converters\n');
    console.log(`   Mode: ${mode}`);
    console.log(`   Schema: ${schemaPath}`);
    console.log(`   Converter paths: ${convertersPaths.join(', ')}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping prisma-converter validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const fullSchemaPath = path.join(workspaceRoot, schemaPath);
    const prismaModels = parsePrismaModels(fullSchemaPath);

    if (prismaModels.size === 0) {
        console.log('⏭️  No models found in schema.prisma');
        console.log('');
        return { success: true };
    }

    console.log(`   Found ${prismaModels.size} model(s) in schema.prisma`);

    const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    // Split changed files into converter files vs non-converter files
    const converterFiles = changedFiles.filter((f) =>
        convertersPaths.some((cp) => f.startsWith(cp))
    );
    const nonConverterFiles = changedFiles.filter((f) =>
        !convertersPaths.some((cp) => f.startsWith(cp))
    );

    const allViolations: PrismaConverterViolation[] = [];

    // Check converter files for method pattern violations
    if (converterFiles.length > 0) {
        console.log(`📂 Checking ${converterFiles.length} converter file(s)...`);

        for (const file of converterFiles) {
            const fileViolations = findConverterViolationsInFile(file, workspaceRoot, prismaModels);
            allViolations.push(...fileViolations);
        }
    }

    // Check non-converter files for Dto creation outside converters
    if (nonConverterFiles.length > 0) {
        console.log(`📂 Checking ${nonConverterFiles.length} non-converter file(s) for Dto creation...`);

        for (const file of nonConverterFiles) {
            const fileViolations = findDtoCreationOutsideConverters(file, workspaceRoot, prismaModels, convertersPaths);
            allViolations.push(...fileViolations);
        }
    }

    if (allViolations.length === 0) {
        console.log('✅ All converter patterns are valid');
        return { success: true };
    }

    reportViolations(allViolations, mode);

    return { success: false };
}
