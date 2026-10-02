import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/** Source imports are the Nx plugin's product; installation edges belong to the umbrella. */
class ProductionImports {
    readonly packages = new Set<string>();

    scan(directory: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === '__tests__') continue;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) this.scan(full);
            else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
                const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
                this.visit(source);
            }
        }
    }

    private add(specifier: ts.Expression | undefined): void {
        if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('@webpieces/')) {
            this.packages.add(specifier.text.split('/').slice(0, 2).join('/'));
        }
    }

    private visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) this.add(node.moduleSpecifier);
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) this.add(node.arguments[0]);
        ts.forEachChild(node, (child: ts.Node): void => this.visit(child));
    }
}

describe('Nx plugin has only the workspace dependencies its production source imports', () => {
    it('has no missing or aggregation-only dependencies', (): void => {
        const plugin = path.resolve(__dirname, '../../../../nx-webpieces-rules');
        const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
        const source = new ProductionImports();
        source.scan(path.join(plugin, 'src'));
        source.scan(path.join(plugin, 'templates'));
        expect(Object.keys(manifest.dependencies).filter((name: string): boolean => name.startsWith('@webpieces/')).sort())
            .toEqual([...source.packages].sort());
    });
});
