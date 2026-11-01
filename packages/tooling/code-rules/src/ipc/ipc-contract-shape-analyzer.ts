/**
 * `ipc-contract-shape` judgement (#1389): one contract-library file, its syntax tree only. Ports the
 * per-file half of the consumer script's `metadata.mjs` plus the contract-import half of `inspect.mjs`:
 *
 *   - a directional API class (name ends in a configured suffix) carries `@WpInternal('<literal id>')`;
 *   - every method carries `@WpIpcEndpoint('<literal id>')` (a given `kind` is the literal `request` or
 *     `notification`) and an explicit `@MaskLog(...)`; ids are unique in the class, API ids in the file;
 *   - every method takes ONE required parameter typed by a named DTO and declares a `Promise<…>` return;
 *   - a contract file imports no host/factory package and nothing that resolves into endpoint/runtime code.
 *
 * Decorators are recognised by the name their import binds (`import { WpInternal as Internal }` counts),
 * exactly like the checker-based script, which compared the unaliased symbol name. Cross-file facts — API
 * ids unique across the library, wire-table agreement — are `ipc-pairing`'s.
 */

import * as ts from 'typescript';
import { matchesAnyGlob } from '@webpieces/rules-config';
import { IpcContractShapeConfig } from '../configs/ipc-configs';
import { IpcFinding, IpcModuleResolver, IpcSourceFile } from './ipc-source';

/** The decorator names of the IPC contract surface (`@webpieces/core-util/ipc`). */
export class IpcContractNames {
    static readonly API_DECORATOR = 'WpInternal';
    static readonly ENDPOINT_DECORATOR = 'WpIpcEndpoint';
    static readonly MASK_DECORATOR = 'MaskLog';
    static readonly ENDPOINT_KINDS: readonly string[] = ['request', 'notification'];
}

const C = IpcContractNames;

/** Syntactic reading of contract decorators, shared by the shape and pairing rules. */
export class IpcContractSyntax {
    /** The `@name(...)` call on `node`, matching the name an import binds or the identifier as written. */
    decoratorCall(file: IpcSourceFile, node: ts.HasDecorators, name: string): ts.CallExpression | undefined {
        for (const decorator of ts.getDecorators(node) ?? []) {
            const expression = decorator.expression;
            if (!ts.isCallExpression(expression)) continue;
            if (this.calleeName(file, expression.expression) === name) return expression;
        }
        return undefined;
    }

    /** The text of a string literal (or a substitution-free template), else undefined. */
    literal(expr: ts.Expression | undefined): string | undefined {
        return expr !== undefined && ts.isStringLiteralLike(expr) ? expr.text : undefined;
    }

    /**
     * The endpoint kind: `request` when no options object is given, the literal `kind` when it is, and
     * undefined when a `kind` is present but not a literal (which the shape rule refuses).
     */
    endpointKind(call: ts.CallExpression): string | undefined {
        const options = call.arguments[1];
        if (options === undefined || !ts.isObjectLiteralExpression(options)) return 'request';
        const kind = options.properties.find(
            (property: ts.ObjectLiteralElementLike) => ts.isPropertyAssignment(property) && property.name.getText() === 'kind',
        );
        if (kind === undefined) return 'request';
        return ts.isPropertyAssignment(kind) ? this.literal(kind.initializer) : undefined;
    }

    isApiClass(node: ts.Node, suffixes: readonly string[]): node is ts.ClassDeclaration {
        if (!ts.isClassDeclaration(node) || node.name === undefined) return false;
        const name = node.name.text;
        return suffixes.some((suffix: string) => name.endsWith(suffix));
    }

    private calleeName(file: IpcSourceFile, callee: ts.Expression): string | undefined {
        if (ts.isIdentifier(callee)) return file.importOf(callee.text)?.imported ?? callee.text;
        if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
        return undefined;
    }
}

export class IpcContractShapeReasons {
    static readonly HOST_IMPORT = 'Shared IPC contracts may import portable schemas/errors, never host or factory implementations.';
    static readonly RUNTIME_IMPORT = 'Shared IPC contracts cannot import endpoint/runtime implementations.';
}

export class IpcContractShapeAnalyzer {
    private readonly syntax = new IpcContractSyntax();

    constructor(
        private readonly config: IpcContractShapeConfig,
        private readonly resolver: IpcModuleResolver,
    ) {}

    analyze(file: IpcSourceFile): IpcFinding[] {
        const out: IpcFinding[] = [...this.judgeImports(file)];
        const apiIds = new Map<string, string>();
        for (const statement of file.source.statements) {
            if (!this.syntax.isApiClass(statement, this.config.apiClassSuffixes)) continue;
            out.push(...this.judgeApi(file, statement, apiIds));
        }
        return out;
    }

    private judgeImports(file: IpcSourceFile): IpcFinding[] {
        const out: IpcFinding[] = [];
        for (const statement of file.source.statements) {
            const declaration = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement : undefined;
            const specifier = declaration?.moduleSpecifier;
            if (declaration === undefined || specifier === undefined || !ts.isStringLiteral(specifier)) continue;
            if (matchesAnyGlob(specifier.text, this.config.forbiddenImportModules)) {
                out.push(file.finding(declaration, IpcContractShapeReasons.HOST_IMPORT));
                continue;
            }
            const target = this.resolver.resolve(file.relFile, specifier.text);
            if (target !== undefined && matchesAnyGlob(target, this.config.forbiddenImportPaths)) {
                out.push(file.finding(declaration, IpcContractShapeReasons.RUNTIME_IMPORT));
            }
        }
        return out;
    }

    private judgeApi(file: IpcSourceFile, api: ts.ClassDeclaration, apiIds: Map<string, string>): IpcFinding[] {
        const name = api.name?.text ?? '<anonymous>';
        const decorator = this.syntax.decoratorCall(file, api, C.API_DECORATOR);
        const out: IpcFinding[] = [];
        if (decorator === undefined) {
            out.push(file.finding(api.name ?? api, `IPC ${name} needs @WpInternal('<api-id>') metadata.`));
        } else {
            const id = this.syntax.literal(decorator.arguments[0]);
            const clash = id === undefined ? undefined : apiIds.get(id);
            if (id === undefined || clash !== undefined) {
                out.push(file.finding(decorator, `IPC ${name} needs one uniquely identified @WpInternal id${clash ? ` (also used by ${clash})` : ''}.`));
            }
            if (id !== undefined && clash === undefined) apiIds.set(id, name);
        }
        const methodIds = new Set<string>();
        for (const member of api.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            out.push(...this.judgeMethod(file, name, member, methodIds));
        }
        return out;
    }

    private judgeMethod(file: IpcSourceFile, api: string, method: ts.MethodDeclaration, methodIds: Set<string>): IpcFinding[] {
        const name = method.name.getText(file.source);
        const label = `IPC ${api}.${name}`;
        const out: IpcFinding[] = [];
        const endpoint = this.syntax.decoratorCall(file, method, C.ENDPOINT_DECORATOR);
        if (endpoint === undefined) {
            out.push(file.finding(method.name, `${label} needs @WpIpcEndpoint('<method-id>') metadata.`));
        } else {
            const id = this.syntax.literal(endpoint.arguments[0]);
            if (id === undefined || methodIds.has(id)) {
                out.push(file.finding(endpoint, `${label} requires one uniquely identified @WpIpcEndpoint id.`));
            }
            if (id !== undefined) methodIds.add(id);
            const kind = this.syntax.endpointKind(endpoint);
            if (kind === undefined || !C.ENDPOINT_KINDS.includes(kind)) {
                out.push(file.finding(endpoint, `${label} @WpIpcEndpoint kind must be the literal 'request' or 'notification'.`));
            }
        }
        if (this.syntax.decoratorCall(file, method, C.MASK_DECORATOR) === undefined) {
            out.push(file.finding(method.name, `${label} needs explicit @MaskLog metadata.`));
        }
        if (!this.hasOneNamedRequest(method) || !this.returnsPromise(method)) {
            out.push(file.finding(method.name, `${label} must take one named required DTO and return Promise.`));
        }
        return out;
    }

    private hasOneNamedRequest(method: ts.MethodDeclaration): boolean {
        if (method.parameters.length !== 1) return false;
        const parameter = method.parameters[0];
        if (parameter.questionToken !== undefined || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) {
            return false;
        }
        return parameter.type !== undefined && ts.isTypeReferenceNode(parameter.type);
    }

    private returnsPromise(method: ts.MethodDeclaration): boolean {
        const type = method.type;
        if (type === undefined || !ts.isTypeReferenceNode(type)) return false;
        const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
        return name === 'Promise';
    }
}
