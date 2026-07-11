/**
 * Validate Inject Annotation Not Needed For Concrete Class
 *
 * Flags a REDUNDANT `@inject(X)` on a CONSTRUCTOR parameter whose token is textually identical to the
 * parameter's own declared type:
 *
 *   BAD:   constructor(@inject(RequestContextHeaders) private readonly h: RequestContextHeaders) {}
 *   GOOD:  constructor(private readonly h: RequestContextHeaders) {}
 *
 * WHY: in this inversify setup a constructor parameter is auto-resolved by its class TYPE via
 * reflect-metadata (`emitDecoratorMetadata` emits `design:paramtypes`). So `private readonly h: Foo`
 * already binds `Foo` — the `@inject(Foo)` adds nothing (see CLAUDE.md, and the sibling
 * no-symbol-di-tokens rule that pushes the same inject-by-type pattern). AI keeps carpet-bombing
 * `@inject`; this fails the build on the redundant form so it stops.
 *
 * Uses the TypeScript AST (not a regex) so "token equals the parameter type" is decided precisely.
 * That single rule is what makes every LEGITIMATE token pass untouched — a real token never equals the
 * type it resolves:
 *   - `@inject(TASK_PROXY_CLIENT_PROVIDER) x: Provider<TaskProxyClient>`  (Symbol token ≠ type)
 *   - `@inject(WEBPIECES_CONFIG_TOKEN) c: WebpiecesConfig`                (Symbol ≠ interface type)
 *   - `@inject('some-string') x: Foo`                                     (string token ≠ type)
 *   - `@inject(Symbol.for('X')) x: Foo`                                   (not a bare identifier)
 *
 * SCOPE: only CONSTRUCTOR parameters. Property injection (`@inject(Foo) private foo: Foo` on a class
 * field) genuinely REQUIRES `@inject` in inversify — there is no design:type auto-wiring for properties
 * — so it is left alone.
 *
 * ALLOWED (skip — NOT violations)
 * - Any `@inject(TOKEN)` whose token differs from the parameter's type (Symbols, string tokens,
 *   provider tokens, interface tokens).
 * - Property/field injection, and any parameter without an `@inject` decorator.
 * - Test files (*.test.ts, *.spec.ts, __tests__/**).
 * - Files under a configured `allowedPaths` glob (shared isPathExcluded glob/prefix/segment semantics).
 * - Lines with `// webpieces-disable inject-annotation-not-needed-for-concrete-class -- <reason>`
 *   (only when disableAllowed).
 *
 * MODES (AST + LINE-SCOPED)
 * - OFF:                    Skip.
 * - NEW_AND_MODIFIED_CODE:  Flag only on changed lines (diff hunks).
 * - NEW_AND_MODIFIED_FILES: Flag every occurrence in any modified file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { hasDisable, RULE_NAMES, InjectAnnotationNotNeededForConcreteClassConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers, isPathExcluded } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

const RULE_NAME = RULE_NAMES.INJECT_ANNOTATION_NOT_NEEDED_FOR_CONCRETE_CLASS;

const SHARED_MESSAGE = `@inject(Foo) on a constructor parameter typed \`: Foo\` is noise — inversify resolves a constructor
parameter by its class type via reflect-metadata, so \`private readonly foo: Foo\` already binds it
(see CLAUDE.md). Pick one:
  Fix Option 1 (PREFERRED): delete the decorator — constructor(private readonly foo: Foo) {}
  Fix Option 2: if you actually need a DIFFERENT binding token (a Symbol for a generated
     http-client-node / cloud-tasks client, or an interface/config with multiple impls), inject that
     token so it DIFFERS from the type: @inject(FOO_TOKEN) foo: SomeInterface.
Property injection (@inject on a class field, not a constructor param) is NOT flagged — it genuinely
needs @inject. Only a constructor param whose token equals its own type is redundant.`;

interface InjectViolation {
    file: string;
    line: number;
    column: number;
    context: string;
}

interface InjectViolationInfo {
    line: number;
    column: number;
    context: string;
    hasDisableComment: boolean;
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function isTestFile(filePath: string): boolean {
    return filePath.includes('.spec.ts') || filePath.includes('.test.ts') || filePath.includes('__tests__/');
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function isDeclarationFile(filePath: string): boolean {
    return filePath.endsWith('.d.ts');
}

// The violation line (or the line just above it) carries the disable comment.
// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function hasDisableOnLine(fileLines: string[], lineNumber: number): boolean {
    const current = fileLines[lineNumber - 1] ?? '';
    const previous = lineNumber >= 2 ? (fileLines[lineNumber - 2] ?? '') : '';
    return hasDisable(current, RULE_NAME) || hasDisable(previous, RULE_NAME);
}

// The `@inject(X)` decorator's single argument, when it is a BARE identifier (a class/token name).
// Returns null for Symbol.for(...), property-access (`Symbol.x`), string literals, or a non-inject
// decorator — those can never equal the parameter type, so they are never redundant.
// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function injectIdentifierArg(decorator: ts.Decorator): string | null {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr)) return null;
    if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'inject') return null;
    if (expr.arguments.length !== 1) return null;
    const arg = expr.arguments[0];
    return arg && ts.isIdentifier(arg) ? arg.text : null;
}

// The parameter's declared type when it is a simple `TypeReference` with an identifier name
// (`Foo`, or `Foo<Bar>` → `Foo`). Qualified names (`ns.Foo`) and non-references return null.
// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function paramTypeName(param: ts.ParameterDeclaration): string | null {
    const typeNode = param.type;
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
    return ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : null;
}

// AST scan: a CONSTRUCTOR parameter is a violation when it carries `@inject(X)` and its declared type
// is exactly `X`. Property injection and method params are ignored (only constructor params).
// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
export function findRedundantInjectInSource(content: string, filePath: string, disableAllowed: boolean): InjectViolationInfo[] {
    if (isDeclarationFile(filePath)) return [];
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const violations: InjectViolationInfo[] = [];

    function checkParameter(param: ts.ParameterDeclaration): void {
        const decorators = ts.canHaveDecorators(param) ? ts.getDecorators(param) : undefined;
        if (!decorators) return;
        const typeName = paramTypeName(param);
        if (!typeName) return;
        for (const decorator of decorators) {
            if (injectIdentifierArg(decorator) === typeName) {
                recordViolation(param, `@inject(${typeName}) is redundant — the parameter is typed \`: ${typeName}\` and resolves by type`, fileLines, sourceFile, violations, disableAllowed);
                return;
            }
        }
    }

    function visit(node: ts.Node): void {
        if (ts.isConstructorDeclaration(node)) {
            for (const param of node.parameters) checkParameter(param);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function recordViolation(
    node: ts.Node,
    context: string,
    fileLines: string[],
    sourceFile: ts.SourceFile,
    violations: InjectViolationInfo[],
    disableAllowed: boolean,
): void {
    const startPos = node.getStart(sourceFile);
    if (startPos < 0) return;
    const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
    const line = pos.line + 1;
    const column = pos.character + 1;
    const disabled = hasDisableOnLine(fileLines, line);
    // When disableAllowed is false, a disable comment does NOT clear the violation.
    const effectiveDisabled = disableAllowed ? disabled : false;
    violations.push({ line, column, context, hasDisableComment: effectiveDisabled });
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function findRedundantInjectInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean, allowedPaths: string[]): InjectViolationInfo[] {
    if (isTestFile(filePath)) return [];
    if (isPathExcluded(filePath, allowedPaths)) return [];
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];
    const content = fs.readFileSync(fullPath, 'utf-8');
    return findRedundantInjectInSource(content, filePath, disableAllowed);
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function findViolationsForModifiedCode(workspaceRoot: string, changedFiles: string[], base: string, head: string | undefined, disableAllowed: boolean, allowedPaths: string[]): InjectViolation[] {
    const violations: InjectViolation[] = [];
    for (const file of changedFiles) {
        const changedLines = getChangedLineNumbers(getFileDiff(workspaceRoot, file, base, head));
        if (changedLines.size === 0) continue;
        for (const v of findRedundantInjectInFile(file, workspaceRoot, disableAllowed, allowedPaths)) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;
            violations.push({ file, line: v.line, column: v.column, context: v.context });
        }
    }
    return violations;
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean, allowedPaths: string[]): InjectViolation[] {
    const violations: InjectViolation[] = [];
    for (const file of changedFiles) {
        for (const v of findRedundantInjectInFile(file, workspaceRoot, disableAllowed, allowedPaths)) {
            if (disableAllowed && v.hasDisableComment) continue;
            violations.push({ file, line: v.line, column: v.column, context: v.context });
        }
    }
    return violations;
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function reportViolations(violations: InjectViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
    console.error('');
    console.error('❌ Redundant @inject — the parameter\'s type already resolves it.');
    console.error('');
    console.error(SHARED_MESSAGE);
    console.error('');
    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}:${v.column}`);
        console.error(`     ${v.context}`);
    }
    console.error('');
    console.error(disableAllowed
        ? `   Escape hatch (use sparingly): // webpieces-disable ${RULE_NAME} -- <reason>`
        : '   Escape hatch: DISABLED (disableAllowed: false)');
    console.error(`   Whole-tree exemption: add a glob to ${RULE_NAME}.allowedPaths in webpieces.config.json`);
    console.error(`\n   Current mode: ${mode}\n`);
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') return normalMode;
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping ${RULE_NAME} validation (${skip.reason})\n`);
        return 'OFF';
    }
    return normalMode;
}

// webpieces-disable no-function-outside-class -- the rule engine is inherently functional; validators can't be class members
async function runValidatorImpl(options: InjectAnnotationNotNeededForConcreteClassConfig, workspaceRoot: string): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;
    const allowedPaths = options.allowedPaths ?? [];

    if (mode === 'OFF') {
        console.log(`\n⏭️  Skipping ${RULE_NAME} validation (mode: OFF)\n`);
        return { success: true };
    }

    console.log(`\n📏 Validating ${RULE_NAME}\n`);
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];
    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log(`\n⏭️  Skipping ${RULE_NAME} validation (could not detect base branch)\n`);
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

    let violations: InjectViolation[] = [];
    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed, allowedPaths);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed, allowedPaths);
    }

    if (violations.length === 0) {
        console.log('✅ No redundant-@inject violations found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);
    return { success: false };
}

@provideSingleton()
@injectable()
export class InjectAnnotationNotNeededForConcreteClassValidator extends CodeValidator<InjectAnnotationNotNeededForConcreteClassConfig> {
    constructor(config: InjectAnnotationNotNeededForConcreteClassConfig) {
        super(config, RULE_NAME);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
