/**
 * API-lib tag validator (two-way)
 *
 * Keeps the two api roles and the CODE in sync, both directions (#1064, D1 + D3):
 *   - a project that exports an `@ApiPath`/`@Rpc`/`@PubSub` contract (or a vendor contract under
 *     `externalApiPaths`) MUST be tagged `role:api-lib` or `role:api-client` — else the arch graph, the
 *     edge line-styles, and validate-api-relations can't treat it as one;
 *   - a project tagged `role:api-lib` MUST export a contract or ONLY wire types — else the tag is a lie.
 *     A contract is any of: an `@ApiPath`/`@Rpc`/`@PubSub` class (from the scan), an IPC contract
 *     (`@WpInternal` / `@WpIpcEndpoint`), or an in-process abstract `…Api` behind a DI token. A DTO-only
 *     library exports interfaces, type aliases, enums, data classes (no methods), and data-only constants;
 *   - a project tagged `role:api-client` MUST export a contract: either an abstract `XxxApi`, or an
 *     exported `XxxApi` interface implemented by a client registered with `@provideSingletonDefaultForApi`.
 *     The bundled client beside it is the point of the role, so it is not judged as a wire type.
 *
 * "Exports an @ApiPath contract" is answered by the same source scan that owns apiRelations
 * (scan.apiLibProjects), so the tag can never drift from the code. The IPC / in-process / DTO-only
 * reading is a parser-only pass over the project's own non-test `src/**` — {@link ApiLibExportShape}.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ProjectInfo } from '../project-info';
import { resolveRole } from '../role-resolver';
import { ApiScanResult } from './api-scanner';
import { collectTsFiles, isTestFile } from './api-ast';

const API_LIB_ROLE = 'api-lib';
const API_CLIENT_ROLE = 'api-client';

/** The decorators that make an abstract class an IPC contract. */
const IPC_DECORATORS: readonly string[] = ['WpInternal', 'WpIpcEndpoint'];

/**
 * A tag/code mismatch:
 *  - 'missing-tag'     — exports an API contract but is tagged neither role:api-lib nor role:api-client.
 *  - 'unnecessary-tag' — tagged role:api-lib / role:api-client but exports no contract, and (for
 *                        api-lib) is not a DTO-only library either; `offenders` names what it exports.
 */
export class ApiLibTagViolation {
    constructor(
        public readonly project: string,
        public readonly kind: 'missing-tag' | 'unnecessary-tag',
        /** The role it carries (for 'unnecessary-tag'), else the role it should carry. */
        public readonly role: string,
        /** Exports that are neither a contract nor a wire type — empty for 'missing-tag'. */
        public readonly offenders: readonly string[] = [],
    ) {}
}

/** What a library's own source exports, sorted into contracts, wire types and everything else. */
export class ApiLibExportShape {
    constructor(
        /** True when it exports an IPC contract or an in-process abstract `…Api`. */
        public readonly exportsContract: boolean,
        /** True when it exports at least one wire type (interface, alias, enum, data class). */
        public readonly exportsWireType: boolean,
        /** `kind Name (file)` of every export that is neither — the implementation an api-lib must not hold. */
        public readonly offenders: readonly string[],
    ) {}

    /** A role:api-lib passes when it holds a contract or wire types, and nothing else. */
    isApiLib(): boolean {
        return (this.exportsContract || this.exportsWireType) && this.offenders.length === 0;
    }

    /** Parser-only: every top-level EXPORTED declaration in the project's non-test `src/**`. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static read(projectDir: string): ApiLibExportShape {
        const srcDir = path.join(projectDir, 'src');
        const acc = new ExportShapeAccumulator(projectDir);
        if (fs.existsSync(srcDir)) {
            for (const file of collectTsFiles(srcDir)) {
                if (isTestFile(file)) continue;
                const source = ts.createSourceFile(
                    file,
                    fs.readFileSync(file, 'utf8'),
                    ts.ScriptTarget.Latest,
                    true,
                );
                for (const statement of source.statements) acc.add(statement, file);
            }
        }
        return acc.shape();
    }
}

/** Sorts each exported statement of one library into contract / wire type / offender. */
class ExportShapeAccumulator {
    private contract = false;
    private wire = false;
    private readonly offenders: string[] = [];
    private readonly apiInterfaces = new Set<string>();
    private readonly registeredApiImplementations = new Set<string>();

    constructor(private readonly projectDir: string) {}

    add(statement: ts.Statement, file: string): void {
        if (!this.isExported(statement)) return;
        const where = path.relative(this.projectDir, file);
        if (ts.isInterfaceDeclaration(statement)) {
            this.wire = true;
            if (statement.name.text.endsWith('Api')) this.apiInterfaces.add(statement.name.text);
        } else if (ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
            this.wire = true;
        } else if (ts.isClassDeclaration(statement)) {
            this.addClass(statement, where);
        } else if (ts.isVariableStatement(statement)) {
            for (const decl of statement.declarationList.declarations) {
                if (this.isDiToken(decl.initializer) || this.isDataConstant(decl.initializer))
                    continue;
                this.offenders.push(`const ${decl.name.getText()} (${where})`);
            }
        } else if (ts.isFunctionDeclaration(statement)) {
            this.offenders.push(`function ${statement.name?.text ?? '<default>'} (${where})`);
        }
    }

    shape(): ApiLibExportShape {
        const registeredInterface = [...this.apiInterfaces].some((name: string) =>
            this.registeredApiImplementations.has(name),
        );
        return new ApiLibExportShape(
            this.contract || registeredInterface,
            this.wire,
            [...this.offenders].sort(),
        );
    }

    private addClass(cls: ts.ClassDeclaration, where: string): void {
        const name = cls.name?.text ?? '<default>';
        if (this.hasDecorator(cls, 'provideSingletonDefaultForApi')) {
            for (const heritage of cls.heritageClauses ?? []) {
                if (heritage.token !== ts.SyntaxKind.ImplementsKeyword) continue;
                for (const type of heritage.types) {
                    const implemented = type.expression.getText().split('.').pop();
                    if (implemented !== undefined)
                        this.registeredApiImplementations.add(implemented);
                }
            }
        }
        const isAbstract = (ts.getModifiers(cls) ?? []).some(
            (m: ts.Modifier) => m.kind === ts.SyntaxKind.AbstractKeyword,
        );
        if (isAbstract && (name.endsWith('Api') || this.carriesIpc(cls))) {
            this.contract = true;
            return;
        }
        const hasMethod = cls.members.some(
            (member: ts.ClassElement) =>
                ts.isMethodDeclaration(member) &&
                !(ts.getModifiers(member) ?? []).some(
                    (m: ts.Modifier) => m.kind === ts.SyntaxKind.StaticKeyword,
                ),
        );
        if (hasMethod)
            this.offenders.push(
                `class ${name} (${where}) — it has methods, so it is an implementation`,
            );
        else this.wire = true;
    }

    /** `@WpInternal(...)` on the class or `@WpIpcEndpoint(...)` on any member. */
    private carriesIpc(cls: ts.ClassDeclaration): boolean {
        const named = (node: ts.Node): boolean =>
            IPC_DECORATORS.some((name: string) => this.hasDecorator(node, name));
        return named(cls) || cls.members.some((member: ts.ClassElement) => named(member));
    }

    private hasDecorator(node: ts.Node, expected: string): boolean {
        return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []).some(
            (decorator: ts.Decorator) => {
                const expr = ts.isCallExpression(decorator.expression)
                    ? decorator.expression.expression
                    : decorator.expression;
                const name = ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.getText();
                return name === expected;
            },
        );
    }

    /** Literal/structural protocol data is contract support, not an executable implementation. */
    private isDataConstant(init: ts.Expression | undefined): boolean {
        if (init === undefined) return false;
        const expr = this.unwrap(init);
        if (
            ts.isStringLiteralLike(expr) ||
            ts.isNumericLiteral(expr) ||
            expr.kind === ts.SyntaxKind.TrueKeyword ||
            expr.kind === ts.SyntaxKind.FalseKeyword ||
            expr.kind === ts.SyntaxKind.NullKeyword ||
            ts.isIdentifier(expr) ||
            ts.isPropertyAccessExpression(expr)
        ) {
            return true;
        }
        if (ts.isPrefixUnaryExpression(expr)) return this.isDataConstant(expr.operand);
        if (ts.isBinaryExpression(expr)) {
            return this.isDataConstant(expr.left) && this.isDataConstant(expr.right);
        }
        if (ts.isConditionalExpression(expr)) {
            return (
                this.isDataConstant(expr.condition) &&
                this.isDataConstant(expr.whenTrue) &&
                this.isDataConstant(expr.whenFalse)
            );
        }
        if (ts.isTemplateExpression(expr)) {
            return expr.templateSpans.every((span: ts.TemplateSpan) =>
                this.isDataConstant(span.expression),
            );
        }
        if (ts.isArrayLiteralExpression(expr)) {
            return expr.elements.every(
                (element: ts.Expression) =>
                    ts.isOmittedExpression(element) ||
                    (ts.isSpreadElement(element)
                        ? this.isDataConstant(element.expression)
                        : this.isDataConstant(element)),
            );
        }
        if (ts.isObjectLiteralExpression(expr)) {
            return expr.properties.every((prop: ts.ObjectLiteralElementLike) => {
                if (ts.isPropertyAssignment(prop)) return this.isDataConstant(prop.initializer);
                if (ts.isShorthandPropertyAssignment(prop)) return true;
                if (ts.isSpreadAssignment(prop)) return this.isDataConstant(prop.expression);
                return false;
            });
        }
        return false;
    }

    private unwrap(expr: ts.Expression): ts.Expression {
        if (
            ts.isAsExpression(expr) ||
            ts.isTypeAssertionExpression(expr) ||
            ts.isSatisfiesExpression(expr) ||
            ts.isParenthesizedExpression(expr) ||
            ts.isNonNullExpression(expr)
        ) {
            return this.unwrap(expr.expression);
        }
        return expr;
    }

    /** `Symbol('x')`, `Symbol.for('x')`, or an object literal of them — the token an abstract `…Api` binds behind. */
    private isDiToken(init: ts.Expression | undefined): boolean {
        if (init === undefined) return false;
        const expr =
            ts.isAsExpression(init) || ts.isSatisfiesExpression(init) ? init.expression : init;
        if (ts.isCallExpression(expr)) {
            const callee = expr.expression.getText();
            return callee === 'Symbol' || callee === 'Symbol.for';
        }
        if (ts.isObjectLiteralExpression(expr)) {
            return (
                expr.properties.length > 0 &&
                expr.properties.every(
                    (prop: ts.ObjectLiteralElementLike) =>
                        ts.isPropertyAssignment(prop) && this.isDiToken(prop.initializer),
                )
            );
        }
        return false;
    }

    private isExported(statement: ts.Statement): boolean {
        if (!ts.canHaveModifiers(statement)) return false;
        return (ts.getModifiers(statement) ?? []).some(
            (m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
    }
}

/** Both-directions tag ⇔ code check. Uses the scan's detected api-lib set as ground truth for @ApiPath. */
// webpieces-disable no-function-outside-class -- validator-lib entry point, matches api-relations-validator.ts
export function findApiLibTagViolations(
    projectInfos: Map<string, ProjectInfo>,
    scan: ApiScanResult,
    workspaceRoot: string,
): ApiLibTagViolation[] {
    const violations: ApiLibTagViolation[] = [];
    for (const projectName of projectInfos.keys()) {
        const info = projectInfos.get(projectName)!;
        const role = resolveRole(info).role;
        const isApiRole = role === API_LIB_ROLE || role === API_CLIENT_ROLE;
        const exportsApi = scan.apiLibProjects.has(projectName);

        if (exportsApi && !isApiRole) {
            violations.push(new ApiLibTagViolation(projectName, 'missing-tag', API_LIB_ROLE));
        }
        // Only judge a tag when we actually SCANNED the project's source — otherwise we can't prove it
        // exports no contract (an unscannable project would falsely look empty).
        if (!isApiRole || exportsApi || !scan.scannedProjects.has(projectName)) continue;
        const shape = ApiLibExportShape.read(path.resolve(workspaceRoot, info.root));
        const ok = role === API_CLIENT_ROLE ? shape.exportsContract : shape.isApiLib();
        if (!ok)
            violations.push(
                new ApiLibTagViolation(projectName, 'unnecessary-tag', role, shape.offenders),
            );
    }
    return violations.sort((a: ApiLibTagViolation, b: ApiLibTagViolation) =>
        a.project.localeCompare(b.project),
    );
}

/** Human-readable, fix-oriented report for one tag/code mismatch. */
// webpieces-disable no-function-outside-class -- pure formatter, matches api-relations-validator.ts
export function describeApiLibTagViolation(violation: ApiLibTagViolation): string {
    if (violation.kind === 'missing-tag') {
        return (
            `  ❌ '${violation.project}' exports an API contract (an abstract @ApiPath/@Rpc/@PubSub class) ` +
            `but is tagged neither 'role:api-lib' nor 'role:api-client'.\n` +
            `     Add "role:api-lib" to its project.json "tags" (replacing any "role:lib"), or "role:api-client" ` +
            `when it also bundles the default implementation that talks to an outside system.`
        );
    }
    if (violation.role === API_CLIENT_ROLE) {
        return (
            `  ❌ '${violation.project}' is tagged 'role:api-client' but exports NO contract (no abstract ` +
            `…Api class, no @WpInternal/@WpIpcEndpoint contract, and no exported …Api interface implemented ` +
            `by an @provideSingletonDefaultForApi client).\n` +
            `     An api-client is a contract PLUS its default implementation: export the XxxApi the registered ` +
            `client implements, or retag it (e.g. "role:lib").`
        );
    }
    const offenders =
        violation.offenders.length === 0
            ? ''
            : `\n     It exports, besides contracts and wire types: ${violation.offenders.join('; ')}.`;
    return (
        `  ❌ '${violation.project}' is tagged 'role:api-lib' but is neither a contract library (@ApiPath/@Rpc/` +
        `@PubSub, @WpInternal/@WpIpcEndpoint, or an abstract …Api behind a DI token) nor a DTO-only library ` +
        `(interfaces, type aliases, enums and data classes only).${offenders}\n` +
        `     Move the implementation out to a role:lib / role:designed-lib project, or retag it.`
    );
}
