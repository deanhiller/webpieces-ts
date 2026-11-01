/**
 * Follows a receiver registration's controller argument to its class, and that class's `extends` chain to
 * the shared contract — syntactically, across exactly the files the chain passes through (#1389).
 *
 * The replaced script asked the checker for the controller's base types, which required every endpoint
 * file in one program. A registration is written in a few recognisable shapes, and those are what this
 * follows: `new Controller(…)`, a `const` initialised with one (in the same file or imported), and for
 * `createScoped` an object whose `create` returns one. Anything else is reported as unresolvable rather
 * than passed — the rule fails closed.
 */

import * as ts from 'typescript';
import { matchesAnyGlob } from '@webpieces/rules-config';
import { IpcFileReader, IpcModuleResolver, IpcSourceFile } from './ipc-source';

/** A class declaration and the file it is declared in. Data-only. */
export class IpcClassRef {
    constructor(
        readonly file: IpcSourceFile,
        readonly declaration: ts.ClassDeclaration,
    ) {}
}

/** How many files/aliases one resolution may pass through before it is treated as unresolvable. */
const MAX_HOPS = 12;

export class IpcControllerResolver {
    constructor(
        private readonly reader: IpcFileReader,
        private readonly resolver: IpcModuleResolver,
        private readonly contractPaths: readonly string[],
    ) {}

    /** The class a `create(api, <expr>)` controller argument instantiates. */
    controllerOf(file: IpcSourceFile, expr: ts.Expression): IpcClassRef | undefined {
        return this.instanceOf(file, expr, 0);
    }

    /** The class a `createScoped(api, { create })` scope's `create` returns. */
    scopedControllerOf(file: IpcSourceFile, expr: ts.Expression): IpcClassRef | undefined {
        const scope = this.unwrap(expr);
        if (!ts.isObjectLiteralExpression(scope)) return undefined;
        for (const property of scope.properties) {
            if (property.name === undefined || property.name.getText(file.source) !== 'create') continue;
            const returned = this.returnedExpression(property);
            return returned === undefined ? undefined : this.instanceOf(file, returned, 0);
        }
        return undefined;
    }

    /** True when `ref` (or a class it extends, transitively) extends the contract class `contractName`. */
    extendsContract(ref: IpcClassRef, contractName: string, hops = 0): boolean {
        if (hops > MAX_HOPS) return false;
        const base = this.baseExpression(ref.declaration);
        if (base === undefined || !ts.isIdentifier(base)) return false;
        const binding = ref.file.importOf(base.text);
        if (binding !== undefined && binding.imported === contractName) {
            const target = this.resolver.resolve(ref.file.relFile, binding.moduleSpecifier);
            if (target !== undefined && matchesAnyGlob(target, this.contractPaths)) return true;
        }
        const parent = this.classNamed(ref.file, base.text, hops + 1);
        return parent !== undefined && this.extendsContract(parent, contractName, hops + 1);
    }

    private instanceOf(file: IpcSourceFile, expr: ts.Expression, hops: number): IpcClassRef | undefined {
        if (hops > MAX_HOPS) return undefined;
        const node = this.unwrap(expr);
        if (ts.isNewExpression(node)) {
            return ts.isIdentifier(node.expression) ? this.classNamed(file, node.expression.text, hops + 1) : undefined;
        }
        if (!ts.isIdentifier(node)) return undefined;
        const local = this.localInitializer(file, node.text);
        if (local !== undefined) return this.instanceOf(file, local, hops + 1);
        const binding = file.importOf(node.text);
        const target = binding === undefined ? undefined : this.resolver.resolve(file.relFile, binding.moduleSpecifier);
        const targetFile = target === undefined ? undefined : this.reader.read(target);
        if (binding === undefined || targetFile === undefined) return undefined;
        const exported = targetFile.variableInitializer(binding.imported);
        return exported === undefined ? undefined : this.instanceOf(targetFile, exported, hops + 1);
    }

    /** The class named `name` as seen from `file`: declared there, imported, or re-exported to it. */
    private classNamed(file: IpcSourceFile, name: string, hops: number): IpcClassRef | undefined {
        if (hops > MAX_HOPS) return undefined;
        const declared = file.classNamed(name);
        if (declared !== undefined) return new IpcClassRef(file, declared);
        const binding = file.importOf(name);
        if (binding !== undefined) return this.exportedClass(file, binding.moduleSpecifier, binding.imported, hops + 1);
        return undefined;
    }

    /** The class `module` (as written in `from`) exports under `name`, following `export … from`. */
    private exportedClass(from: IpcSourceFile, module: string, name: string, hops: number): IpcClassRef | undefined {
        const target = this.resolver.resolve(from.relFile, module);
        const file = target === undefined ? undefined : this.reader.read(target);
        if (file === undefined || hops > MAX_HOPS) return undefined;
        const declared = file.classNamed(name);
        if (declared !== undefined) return new IpcClassRef(file, declared);
        for (const statement of file.source.statements) {
            if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
            if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
            const reexported = this.reexportedName(statement, name);
            if (reexported === undefined) continue;
            const found = this.exportedClass(file, statement.moduleSpecifier.text, reexported, hops + 1);
            if (found !== undefined) return found;
        }
        return undefined;
    }

    /** The source name `export … from` re-exports as `name`, or undefined when it does not. */
    private reexportedName(statement: ts.ExportDeclaration, name: string): string | undefined {
        const clause = statement.exportClause;
        if (clause === undefined) return name;
        if (!ts.isNamedExports(clause)) return undefined;
        const element = clause.elements.find((each: ts.ExportSpecifier) => each.name.text === name);
        return element === undefined ? undefined : (element.propertyName?.text ?? element.name.text);
    }

    /** The initializer of the nearest `const <name> = …` anywhere in the file. */
    private localInitializer(file: IpcSourceFile, name: string): ts.Expression | undefined {
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found !== undefined) return;
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
                found = node.initializer;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return found;
    }

    private returnedExpression(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
        if (ts.isPropertyAssignment(property)) {
            const value = this.unwrap(property.initializer);
            if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return this.bodyResult(value.body);
            return undefined;
        }
        if (ts.isMethodDeclaration(property) && property.body !== undefined) return this.bodyResult(property.body);
        return undefined;
    }

    private bodyResult(body: ts.ConciseBody): ts.Expression | undefined {
        if (!ts.isBlock(body)) return body;
        for (const statement of body.statements) {
            if (ts.isReturnStatement(statement)) return statement.expression;
        }
        return undefined;
    }

    private baseExpression(declaration: ts.ClassDeclaration): ts.Expression | undefined {
        for (const clause of declaration.heritageClauses ?? []) {
            if (clause.token === ts.SyntaxKind.ExtendsKeyword) return clause.types[0]?.expression;
        }
        return undefined;
    }

    private unwrap(expr: ts.Expression): ts.Expression {
        let node = expr;
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
            node = node.expression;
        }
        return node;
    }
}
