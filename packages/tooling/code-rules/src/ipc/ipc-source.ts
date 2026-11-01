/**
 * The shared syntax layer of the four IPC rules (#1389): one parsed file, its import bindings, and the
 * resolution of a module specifier to a workspace file — all WITHOUT a `ts.Program`.
 *
 * Why no program: the script these rules replace built one over every source file of the monorepo and
 * ran the checker over all of it; a program keeps every AST and symbol table resident, so its memory grew
 * with the repo and exhausted Node's default heap on CI. Each rule here reads exactly the files it judges.
 * A specifier is resolved with `ts.resolveModuleName`, which probes the file system for ONE specifier and
 * builds nothing; the tsconfig is parsed with a host that never enumerates the repo's files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { InformAiError } from '@webpieces/tooling-common';

/** One refused site: where it is and why. Data-only. */
export class IpcFinding {
    constructor(
        /** Workspace-relative. */
        readonly relFile: string,
        /** 1-based. */
        readonly line: number,
        readonly snippet: string,
        readonly message: string,
    ) {}
}

/** One name an import declaration binds. Data-only. */
export class IpcImportBinding {
    constructor(
        /** The local name in this file. */
        readonly local: string,
        /** The exported name it refers to; `default` or `*` (namespace) for those forms. */
        readonly imported: string,
        readonly moduleSpecifier: string,
        /** `import type` or an inline `type` specifier — erased at compile time. */
        readonly typeOnly: boolean,
        readonly node: ts.Node,
    ) {}
}

/** One parsed source file, workspace-relative, with its import bindings. */
export class IpcSourceFile {
    private bindings: IpcImportBinding[] | undefined;

    constructor(
        readonly relFile: string,
        readonly source: ts.SourceFile,
    ) {}

    lineOf(node: ts.Node): number {
        return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
    }

    snippetOf(node: ts.Node): string {
        const text = node.getText(this.source).replace(/\s+/g, ' ').trim();
        return text.length > 160 ? `${text.slice(0, 157)}...` : text;
    }

    finding(node: ts.Node, message: string): IpcFinding {
        return new IpcFinding(this.relFile, this.lineOf(node), this.snippetOf(node), message);
    }

    /** Every binding of every top-level import declaration. */
    imports(): readonly IpcImportBinding[] {
        if (this.bindings === undefined) this.bindings = this.readImports();
        return this.bindings;
    }

    /** The import binding a local name refers to, if it is imported. */
    importOf(local: string): IpcImportBinding | undefined {
        return this.imports().find((binding: IpcImportBinding) => binding.local === local);
    }

    /** The top-level class declared with this name, if any. */
    classNamed(name: string): ts.ClassDeclaration | undefined {
        return this.source.statements.find(
            (statement: ts.Statement): statement is ts.ClassDeclaration =>
                ts.isClassDeclaration(statement) && statement.name?.text === name,
        );
    }

    /** The initializer of the top-level `const|let|var <name> = …`, if any. */
    variableInitializer(name: string): ts.Expression | undefined {
        for (const statement of this.source.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
            }
        }
        return undefined;
    }

    private readImports(): IpcImportBinding[] {
        const out: IpcImportBinding[] = [];
        for (const statement of this.source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
            const clause = statement.importClause;
            if (clause === undefined) continue;
            const specifier = statement.moduleSpecifier.text;
            const clauseTypeOnly = clause.isTypeOnly;
            if (clause.name) out.push(new IpcImportBinding(clause.name.text, 'default', specifier, clauseTypeOnly, clause.name));
            const named = clause.namedBindings;
            if (named !== undefined && ts.isNamespaceImport(named)) {
                out.push(new IpcImportBinding(named.name.text, '*', specifier, clauseTypeOnly, named));
            } else if (named !== undefined) {
                for (const element of named.elements) {
                    const imported = element.propertyName?.text ?? element.name.text;
                    out.push(new IpcImportBinding(element.name.text, imported, specifier, clauseTypeOnly || element.isTypeOnly, element));
                }
            }
        }
        return out;
    }
}

/**
 * Parses workspace files on demand and caches them for one rule run, so a file reached from two
 * registrations is parsed once — and only files a rule actually reaches are ever parsed.
 */
export class IpcFileReader {
    private readonly cache = new Map<string, IpcSourceFile | null>();

    constructor(readonly workspaceRoot: string) {}

    exists(relFile: string): boolean {
        return fs.existsSync(path.join(this.workspaceRoot, relFile));
    }

    /** The parsed file, cached for the rest of the run, or undefined when it does not exist. */
    read(relFile: string): IpcSourceFile | undefined {
        const cached = this.cache.get(relFile);
        if (cached !== undefined) return cached ?? undefined;
        const parsed = this.parse(relFile);
        this.cache.set(relFile, parsed ?? null);
        return parsed;
    }

    /**
     * The parsed file WITHOUT caching it — for a per-file rule walking many files, so each tree is garbage
     * as soon as it is judged and memory stays flat however many files the mode selects.
     */
    parse(relFile: string): IpcSourceFile | undefined {
        const absFile = path.join(this.workspaceRoot, relFile);
        if (!fs.existsSync(absFile)) return undefined;
        const text = fs.readFileSync(absFile, 'utf8');
        const kind = relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        return new IpcSourceFile(relFile, ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, kind));
    }
}

/** A tsconfig host that answers file questions but NEVER lists a directory — no repo walk. */
class NoEnumerationHost implements ts.ParseConfigHost {
    readonly useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;

    readDirectory(): readonly string[] {
        return [];
    }

    fileExists(file: string): boolean {
        return ts.sys.fileExists(file);
    }

    readFile(file: string): string | undefined {
        return ts.sys.readFile(file);
    }
}

/** Reads a tsconfig's compiler options (following `extends`) without enumerating any source file. */
export class IpcCompilerOptionsReader {
    read(workspaceRoot: string, tsconfigPath: string): ts.CompilerOptions {
        const absConfig = path.join(workspaceRoot, tsconfigPath);
        if (!fs.existsSync(absConfig)) {
            throw new InformAiError(
                `IPC rules: tsconfigPath "${tsconfigPath}" does not exist under ${workspaceRoot}. ` +
                    'Point the rule\'s "tsconfigPath" at the tsconfig whose "paths" resolve your imports.',
            );
        }
        const raw = ts.readConfigFile(absConfig, ts.sys.readFile);
        if (raw.error !== undefined) {
            throw new InformAiError(
                `IPC rules: cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, '\n')}`,
            );
        }
        const parsed = ts.parseJsonConfigFileContent(raw.config, new NoEnumerationHost(), path.dirname(absConfig));
        return {
            ...parsed.options,
            noEmit: true,
            skipLibCheck: true,
            allowJs: false,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            jsx: ts.JsxEmit.ReactJSX,
        };
    }
}

/**
 * Resolves a module specifier written in a workspace file to the workspace file it names (relative
 * imports and tsconfig `paths` aliases alike), or undefined for a package or an unresolvable specifier.
 */
export class IpcModuleResolver {
    private readonly cache = new Map<string, string | null>();
    private readonly moduleCache: ts.ModuleResolutionCache;

    constructor(
        private readonly workspaceRoot: string,
        private readonly options: ts.CompilerOptions,
    ) {
        this.moduleCache = ts.createModuleResolutionCache(workspaceRoot, (name: string) => name, options);
    }

    resolve(fromRelFile: string, specifier: string): string | undefined {
        const key = `${path.posix.dirname(fromRelFile)}\u0000${specifier}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached ?? undefined;
        const containing = path.join(this.workspaceRoot, fromRelFile);
        const result = ts.resolveModuleName(specifier, containing, this.options, ts.sys, this.moduleCache);
        const resolved = result.resolvedModule?.resolvedFileName;
        const rel = resolved === undefined ? undefined : this.workspaceRelative(resolved);
        this.cache.set(key, rel ?? null);
        return rel;
    }

    private workspaceRelative(absFile: string): string | undefined {
        const rel = path.relative(this.workspaceRoot, absFile).split(path.sep).join('/');
        if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split('/').includes('node_modules')) return undefined;
        return rel;
    }
}
