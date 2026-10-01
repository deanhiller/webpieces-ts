import * as ts from 'typescript';
import { ApiComponentsModel } from '../model/ApiDocModel';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { DeclaringPackage, PackageOfFile } from './PackageOfFile';
import { TypeResolver } from './TypeResolver';

/** One exported type: its declared name and its declaration. Data-only. */
class ExportedDeclaration {
    constructor(
        readonly name: string,
        readonly declaration: ts.Declaration,
    ) {}
}

/**
 * The DTO-LIBRARY half of {@link ApiDocExtractor} (#1058): every type a library's entry files export
 * and its own package declares, resolved by the same {@link TypeResolver} a contract uses, for the
 * components-only OpenAPI document the library publishes. See `ApiDocExtractor.extractComponents`.
 */
export class ComponentsExtractor {
    constructor(private readonly packages: PackageOfFile) {}

    /**
     * EVERY type a DTO LIBRARY exports and declares — not only the ones some contract reaches, so the
     * document is a property of the library alone.
     *
     * `entryFiles` are the library's public entry points (usually its `src/index.ts`); every symbol
     * they export, re-exports followed, that resolves to an interface, a class, a type alias or an
     * enum DECLARED BY THE LIBRARY'S OWN PACKAGE is resolved with the same resolver a contract uses.
     * A re-export of another package's type is that package's schema, not this one's. A GENERIC
     * declaration has no schema of its own until it is instantiated, so it is left out.
     *
     * @throws ApiDocExtractionError when an entry file is not part of the program, or the entries do
     *         not all belong to one package.
     */
    extract(
        entryFiles: readonly string[],
        compilerOptions: ts.CompilerOptions = {},
    ): ApiComponentsModel {
        const program = ts.createProgram(entryFiles.slice(), compilerOptions);
        const sources = entryFiles.map((file: string) => {
            const source = program.getSourceFile(file);
            if (source === undefined) {
                throw new ApiDocExtractionError(
                    'entry file is not part of the program',
                    file,
                    'Pass an absolute path to a .ts file that exists.',
                );
            }
            return source;
        });
        const home = this.libraryPackage(sources);
        const checker = program.getTypeChecker();
        const resolver = new TypeResolver(checker, this.packages, home.name);
        const exported: string[] = [];
        for (const source of sources) {
            for (const each of this.exportedDeclarations(checker, source)) {
                const name = each.name;
                const declaration = each.declaration;
                if (this.packages.of(declaration.getSourceFile().fileName)?.name !== home.name) {
                    continue;
                }
                resolver.resolveDeclaration(name, declaration, name);
                const key = resolver.keyFor(name, declaration);
                if (resolver.collectedTypes().has(key) && !exported.includes(key)) {
                    exported.push(key);
                }
            }
        }
        return new ApiComponentsModel(
            home.name,
            home.version,
            exported,
            resolver.collectedTypes(),
            resolver.collectedUnmapped(),
            resolver.collectedCollisions(),
        );
    }

    /** The ONE package every entry file belongs to. */
    private libraryPackage(sources: readonly ts.SourceFile[]): DeclaringPackage {
        const first = sources[0];
        if (first === undefined) {
            throw new ApiDocExtractionError(
                'no entry files',
                '<components>',
                'Name at least one entry file of the DTO library, e.g. "src/index.ts".',
            );
        }
        const home = this.packages.of(first.fileName);
        if (home === undefined) {
            throw new ApiDocExtractionError(
                'the entry file belongs to no package',
                first.fileName,
                'A components document is published BY a package: give the library a package.json ' +
                    'with a name and a version.',
            );
        }
        for (const source of sources) {
            const owner = this.packages.of(source.fileName)?.name;
            if (owner !== home.name) {
                throw new ApiDocExtractionError(
                    `the entry files belong to more than one package (${home.name} and ${owner ?? 'no package'})`,
                    source.fileName,
                    'List only the entry files of the one library this document is published by.',
                );
            }
        }
        return home;
    }

    /**
     * Every TYPE `source` exports, re-exports followed, as (declared name, declaration). Values,
     * namespaces and generic declarations are left out: none of them has a schema of its own.
     */
    private exportedDeclarations(
        checker: ts.TypeChecker,
        source: ts.SourceFile,
    ): ExportedDeclaration[] {
        const moduleSymbol = checker.getSymbolAtLocation(source);
        if (moduleSymbol === undefined) {
            return [];
        }
        const found: ExportedDeclaration[] = [];
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
            const symbol =
                (exported.flags & ts.SymbolFlags.Alias) !== 0
                    ? checker.getAliasedSymbol(exported)
                    : exported;
            const declaration = symbol.declarations?.[0];
            if (declaration === undefined) {
                continue;
            }
            const named =
                ts.isInterfaceDeclaration(declaration) ||
                ts.isClassDeclaration(declaration) ||
                ts.isTypeAliasDeclaration(declaration) ||
                ts.isEnumDeclaration(declaration);
            if (!named || declaration.name === undefined) {
                continue;
            }
            const generic =
                !ts.isEnumDeclaration(declaration) && (declaration.typeParameters?.length ?? 0) > 0;
            if (!generic) {
                found.push(new ExportedDeclaration(declaration.name.text, declaration));
            }
        }
        return found;
    }
}
