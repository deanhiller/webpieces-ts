import * as ts from 'typescript';
import { Binding } from './model';
import { relativeFile, resolveTokenKey } from './token-resolver';

/**
 * The host binder's client registrations retain the same DI token and singleton boundary as a
 * hand-written lazy factory: `binder.createRpcClientAndBind(Api, deployment, options?)` and
 * `binder.createPubSubClientAndBind(...)` bind `options.token` when given, else the API class itself.
 * `binder.bindExternal(Api, VendorImpl)` binds the vendor class to its external contract; the browser
 * spelling `binder.bindExternal(Api, new UseClass(Vendor) | new UseExisting(Token))`
 * resolves through to the same implementation class (an alias walks into its target).
 */
export class RuntimeClientBindings {
    collectNode(
        call: ts.CallExpression,
        checker: ts.TypeChecker,
        root: string,
    ): Binding | undefined {
        const method = this.binderMethod(call, checker, 'http-routing');
        if (method === 'createRpcClientAndBind' || method === 'createPubSubClientAndBind')
            return this.client(call, checker, root);
        if (method === 'bindExternal') return this.external(call, checker, root);
        return undefined;
    }

    collectBrowser(
        call: ts.CallExpression,
        checker: ts.TypeChecker,
        root: string,
    ): Binding | undefined {
        const method = this.binderMethod(call, checker, 'http-client-browser');
        if (method === 'createRpcClientAndBind') return this.client(call, checker, root);
        if (method === 'bindExternal') return this.external(call, checker, root);
        return undefined;
    }

    /** The method name when `call` resolves to the host Binder declared in `pkg`; otherwise undefined. */
    private binderMethod(call: ts.CallExpression, checker: ts.TypeChecker, pkg: string): string | undefined {
        if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
        const declaration = checker.getResolvedSignature(call)?.declaration;
        if (declaration === undefined) return undefined;
        const file = declaration.getSourceFile().fileName.replace(/\\/g, '/');
        if (!new RegExp(`(?:/packages/http/|/node_modules/@webpieces/)${pkg}/`).test(file)) return undefined;
        const owner = declaration.parent;
        const ownerName =
            owner !== undefined && (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner))
                ? owner.name?.text
                : undefined;
        return ownerName === 'Binder' ? call.expression.name.text : undefined;
    }

    private client(call: ts.CallExpression, checker: ts.TypeChecker, root: string): Binding | undefined {
        if (call.arguments.length < 2) return;
        const token = resolveTokenKey(this.tokenExpression(call), checker, root);
        return new Binding(
            token.key,
            token.display,
            'toDynamicValue',
            'singleton',
            null,
            call.expression.getText(),
            relativeFile(root, call.getSourceFile()),
            [],
            true,
        );
    }

    private external(call: ts.CallExpression, checker: ts.TypeChecker, root: string): Binding | undefined {
        const api = call.arguments[0];
        const impl = call.arguments[1] === undefined ? undefined : this.externalImpl(call.arguments[1], checker);
        if (api === undefined || impl === undefined) return;
        const token = resolveTokenKey(api, checker, root);
        return new Binding(
            token.key,
            token.display,
            'to',
            'singleton',
            this.implementation(impl, checker),
            impl.getText(),
            relativeFile(root, call.getSourceFile()),
        );
    }

    /** The browser `new UseClass(X)` / `new UseExisting(X)` names X; the Node form is X itself. */
    private externalImpl(expression: ts.Expression, checker: ts.TypeChecker): ts.Expression | undefined {
        if (!ts.isNewExpression(expression)) return expression;
        let recipe = checker.getSymbolAtLocation(expression.expression);
        if (recipe !== undefined && (recipe.flags & ts.SymbolFlags.Alias) !== 0) recipe = checker.getAliasedSymbol(recipe);
        if (recipe === undefined || !['UseClass', 'UseExisting'].includes(recipe.getName())) return undefined;
        return expression.arguments?.[0];
    }

    private implementation(expression: ts.Expression, checker: ts.TypeChecker): ts.ClassDeclaration | null {
        let symbol = checker.getSymbolAtLocation(expression);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
        return symbol?.declarations?.find((declaration: ts.Declaration) => ts.isClassDeclaration(declaration)) as ts.ClassDeclaration | undefined ?? null;
    }

    /** `new ClientBindOptions(token, ...)` names an extra token; omitted, the API class is the token. */
    private tokenExpression(call: ts.CallExpression): ts.Expression {
        const options = call.arguments[2];
        if (options !== undefined && ts.isNewExpression(options)) {
            const token = options.arguments?.[0];
            if (token !== undefined && token.kind !== ts.SyntaxKind.UndefinedKeyword && token.getText() !== 'undefined')
                return token;
        }
        return call.arguments[0];
    }
}
