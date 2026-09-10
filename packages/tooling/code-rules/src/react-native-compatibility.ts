import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import * as ts from 'typescript';

/** Checks the complete runtime import closure, including dependencies, without Node/DOM ambient types. */
export class ReactNativeCompatibility {
    private readonly builtins = new Set(
        builtinModules.map((name: string): string => name.replace(/^node:/, '')),
    );
    private readonly forbidden = new Set([
        'window',
        'document',
        'localStorage',
        'sessionStorage',
        'Buffer',
        'process',
        'require',
        '__dirname',
        '__filename',
        'TextEncoder',
        'TextDecoder',
    ]);

    /** Return actionable violations; callers must fail their build on any entry. */
    inspect(entrypoints: string[], options: ts.CompilerOptions): string[] {
        const problems: string[] = [];
        const seen = new Set<string>();
        const visitFile = (filename: string): void => {
            const absolute = path.resolve(filename);
            if (seen.has(absolute)) return;
            seen.add(absolute);
            if (!fs.existsSync(absolute)) {
                problems.push(`Missing React Native entrypoint: ${absolute}`);
                return;
            }
            const source = ts.createSourceFile(
                absolute,
                fs.readFileSync(absolute, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );
            const imports: string[] = [];
            const walk = (node: ts.Node): void => {
                if (
                    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                    node.moduleSpecifier &&
                    ts.isStringLiteral(node.moduleSpecifier)
                ) {
                    imports.push(node.moduleSpecifier.text);
                }
                if (
                    ts.isCallExpression(node) &&
                    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
                ) {
                    const arg = node.arguments[0];
                    if (!arg || !ts.isStringLiteral(arg))
                        problems.push(`${absolute}: dynamic module loading is not portable`);
                    else imports.push(arg.text);
                }
                if (
                    ts.isIdentifier(node) &&
                    this.forbidden.has(node.text) &&
                    this.isReference(node)
                ) {
                    problems.push(
                        `${absolute}: unsupported React Native global ${node.text}; use a portable implementation or an explicit platform adapter`,
                    );
                }
                const abortProblem = this.abortSignalProblem(absolute, node);
                if (abortProblem) problems.push(abortProblem);
                ts.forEachChild(node, walk);
            };
            walk(source);
            for (const specifier of imports) {
                if (specifier.startsWith('node:') || this.builtins.has(specifier)) {
                    problems.push(
                        `${absolute}: Node module ${specifier} is not React Native compatible`,
                    );
                    continue;
                }
                const resolved = ts.resolveModuleName(
                    specifier,
                    absolute,
                    options,
                    ts.sys,
                ).resolvedModule;
                if (!resolved)
                    problems.push(`${absolute}: cannot resolve ${specifier} for React Native`);
                else {
                    visitFile(resolved.resolvedFileName);
                    // Declarations can conceal a Node-only runtime dependency. Inspect its real JS too.
                    if (
                        resolved.isExternalLibraryImport &&
                        resolved.resolvedFileName.endsWith('.d.ts')
                    ) {
                        visitFile(createRequire(absolute).resolve(specifier));
                    }
                }
            }
        };
        entrypoints.forEach(visitFile);
        return [...new Set(problems)];
    }

    private abortSignalProblem(absolute: string, node: ts.Node): string | undefined {
        if (!ts.isPropertyAccessExpression(node) || !this.isNonPortableAbortSignalExtension(node))
            return undefined;
        return `${absolute}: AbortSignal.${node.name.text} is not React Native compatible; use CallDeadline.throwIfAborted(signal)`;
    }

    /** React Native's abort-controller 3 surface has aborted/addEventListener, but not these DOM additions. */
    private isNonPortableAbortSignalExtension(node: ts.PropertyAccessExpression): boolean {
        if (!['throwIfAborted', 'reason'].includes(node.name.text)) return false;
        return this.isSignalExpression(node.expression);
    }

    private isSignalExpression(expression: ts.Expression): boolean {
        if (ts.isIdentifier(expression)) {
            if (/signal$/i.test(expression.text)) return true;
            return this.hasAbortSignalDeclaration(expression);
        }
        return ts.isPropertyAccessExpression(expression) && expression.name.text === 'signal';
    }

    private hasAbortSignalDeclaration(identifier: ts.Identifier): boolean {
        let found = false;
        const inspect = (node: ts.Node): void => {
            if (found) return;
            if (
                (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
                ts.isIdentifier(node.name) &&
                node.name.text === identifier.text &&
                node.type?.getText() === 'AbortSignal'
            ) {
                found = true;
                return;
            }
            ts.forEachChild(node, inspect);
        };
        inspect(identifier.getSourceFile());
        return found;
    }

    /** A property named process is not a process-global access. globalThis.process IS. */
    private isReference(node: ts.Identifier): boolean {
        const parent = node.parent;
        if (node.text === 'require' && ts.isCallExpression(parent) && parent.expression === node)
            return false;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
            return (
                ts.isIdentifier(parent.expression) &&
                ['globalThis', 'global'].includes(parent.expression.text)
            );
        }
        if (
            (ts.isPropertyDeclaration(parent) ||
                ts.isPropertySignature(parent) ||
                ts.isMethodDeclaration(parent) ||
                ts.isMethodSignature(parent) ||
                ts.isPropertyAssignment(parent)) &&
            parent.name === node
        )
            return false;
        if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
        return true;
    }

    /** Tags are a checked promise, not an alternative to a runnable compatibility target. */
    validateTarget(projectFile: string): string[] {
        const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
        if (!project.tags?.includes('framework:react-native')) return [];
        const target = project.targets?.['react-native-compat'];
        if (!target?.options?.command || !target.dependsOn?.includes('build')) {
            return [
                `${projectFile}: framework:react-native requires a react-native-compat target depending on build`,
            ];
        }
        if (!project.targets?.ci?.dependsOn?.includes('react-native-compat')) {
            return [
                `${projectFile}: ci must depend on react-native-compat; an optional target does not certify React Native support`,
            ];
        }
        return [];
    }
}
