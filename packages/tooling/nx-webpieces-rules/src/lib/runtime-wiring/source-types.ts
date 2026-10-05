import * as ts from 'typescript';

export type WiringKind = 'app' | 'wiring' | 'binding' | 'routing';

/** Identity comes from resolved framework declarations, including aliases and inherited roles. */
export class WiringSourceTypes {
    constructor(private readonly checker: ts.TypeChecker) {}

    declaration(node: ts.Node): ts.Declaration | undefined {
        let symbol = this.checker.getSymbolAtLocation(node);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
            symbol = this.checker.getAliasedSymbol(symbol);
        return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    }

    kind(node: ts.ClassDeclaration | ts.Expression): WiringKind | undefined {
        const declaration = ts.isClassDeclaration(node) ? node : this.declaration(node);
        if (declaration === undefined) return undefined;
        return this.role(declaration, new Set<ts.Declaration>());
    }

    isFramework(node: ts.Node, name: string): boolean {
        const declaration = this.declaration(node);
        if (declaration === undefined || (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration))) return false;
        return declaration.name?.text === name && /(?:\/packages\/(?:http|cloud)\/|\/node_modules\/@webpieces\/)(?:http-routing|http-client-node|http-client-browser|http-client-core|cloudtasks-client)\//.test(declaration.getSourceFile().fileName.replace(/\\/g, '/'));
    }

    method(declaration: ts.ClassDeclaration, name: string): ts.MethodDeclaration | undefined {
        const property = this.checker.getTypeAtLocation(declaration).getProperty(name);
        const method = property?.valueDeclaration;
        return method !== undefined && ts.isMethodDeclaration(method) ? method : undefined;
    }

    isPolicy(node: ts.Expression): boolean {
        const symbol = this.checker.getTypeAtLocation(node).getSymbol();
        const declaration = symbol?.valueDeclaration;
        return declaration !== undefined && ts.isClassDeclaration(declaration) &&
            declaration.name !== undefined && this.isFramework(declaration.name, 'WiringPolicy');
    }

    private role(declaration: ts.Declaration, seen: Set<ts.Declaration>): WiringKind | undefined {
        if (seen.has(declaration)) return undefined;
        seen.add(declaration);
        if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration))
            return undefined;
        const name = declaration.name?.text;
        const file = declaration.getSourceFile().fileName.replace(/\\/g, '/');
        const framework = /(?:\/packages\/http\/|\/node_modules\/@webpieces\/)(?:http-routing|http-client-browser|http-client-core)\/.*Wiring\.(?:d\.)?ts$/.test(file);
        if (framework) {
            if (name === 'AppWiring') return 'app';
            if (name === 'Wiring') return 'wiring';
            if (name === 'BindingModule') return 'binding';
            if (name === 'RouteModule') return 'routing';
        }
        const roles: WiringKind[] = [];
        for (const clause of declaration.heritageClauses ?? []) {
            for (const type of clause.types) {
                const parent = this.declaration(type.expression);
                if (parent === undefined) continue;
                const role = this.role(parent, seen);
                if (role !== undefined) roles.push(role);
            }
        }
        return roles.includes('app') ? 'app' : roles[0];
    }
}
