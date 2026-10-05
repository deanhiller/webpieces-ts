import * as ts from 'typescript';
import { Binding } from './model';
import { relativeFile, resolveTokenKey } from './token-resolver';

/** Canonical lazy client helpers retain the same DI token and singleton boundary. */
export class RuntimeClientBindings {
    collectNode(
        call: ts.CallExpression,
        checker: ts.TypeChecker,
        root: string,
    ): Binding | undefined {
        if (!this.frameworkCall(call, checker)) return;
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee)) return;
        const owner = checker.getTypeAtLocation(callee.expression).getSymbol()?.getName();
        if (
            (callee.name.text === 'bindRpc' && owner === 'RuntimeClients') ||
            (callee.name.text === 'bindPubSub' && owner === 'RuntimeTaskClients')
        ) {
            return this.binding(call, checker, root);
        }
        return undefined;
    }

    collectBrowser(
        call: ts.CallExpression,
        checker: ts.TypeChecker,
        root: string,
    ): Binding | undefined {
        if (!this.frameworkCall(call, checker)) return;
        let symbol = checker.getSymbolAtLocation(call.expression);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
            symbol = checker.getAliasedSymbol(symbol);
        if (
            symbol?.getName() !== 'provideRpcClient' ||
            checker.getTypeAtLocation(call).getSymbol()?.getName() !== 'RpcClientProvider'
        )
            return;
        return this.binding(call, checker, root);
    }

    private frameworkCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
        const declaration = checker.getResolvedSignature(call)?.declaration;
        if (declaration === undefined) return false;
        return /(?:\/packages\/(?:http|cloud)\/|\/node_modules\/@webpieces\/)(?:http-client-node|http-client-browser|cloudtasks-client)\//.test(declaration.getSourceFile().fileName.replace(/\\/g, '/'));
    }

    private binding(
        call: ts.CallExpression,
        checker: ts.TypeChecker,
        root: string,
    ): Binding | undefined {
        if (call.arguments.length < 3) return;
        const token = resolveTokenKey(call.arguments[0], checker, root);
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
}
