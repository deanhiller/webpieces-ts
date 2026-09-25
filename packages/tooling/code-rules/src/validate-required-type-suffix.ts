/**
 * `required-type-suffix` (#1037) — a type's name says which layer it belongs to.
 *
 * Configured as a list of entries, each pairing path globs with the suffixes allowed there:
 *
 *   { "paths": ["libraries/apis/internal/**"], "suffixes": ["Request", "Response", "Event", "Dto", "Api"] }
 *   { "paths": ["libraries/browser-node/fs-*-model/**"], "suffixes": ["Fs"] }
 *
 * Every EXPORTED `interface`, `class` (abstract too), `enum` and `type` alias in a non-test `.ts` file under
 * an entry's paths must end in one of that entry's suffixes — a plain, case-sensitive `endsWith`, and the
 * suffix alone is not a name (`FooDto` passes; `FooDTO` and `Dto` fail). A non-exported, file-local type
 * is not judged, and neither is an exported `const` (a DI token's `Symbol` holder is not a type). A type
 * exported through a local `export { Foo as FooDto }` list is judged by the name it is exported AS.
 *
 * Why: in review a `…Dto` is a wire type and a `…Fs` a Firestore document, while `TopNamePlaceInput` reads
 * the same as a server-internal or vendor type. The suffix is the one place the layer can be stated.
 *
 * Overlapping entries: the FIRST entry in config order whose paths match governs a file
 * ({@link SuffixEntryPicker}), so a narrower entry must be listed before a broader one; suffixes are never
 * unioned across entries.
 *
 * Under NEW_AND_MODIFIED_CODE only a declaration whose NAME line is new or changed is judged — a new type
 * or a renamed one — so legacy names are grandfathered and a repo with hundreds of them can convert slowly.
 */

import {
    DiffScope,
    RULE_NAMES,
    RequiredTypeSuffixConfig,
    RequiredTypeSuffixEntry,
    matchesAnyGlob,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import * as ts from 'typescript';
import { ApiLibFile, ApiLibSite, ApiLibSourceRule } from './api-lib-source-rule';
import { ProjectRoleResolver } from './project-role-resolver';

/** The entry that governs a file, and the glob of it that matched — named in every failure. Data-only. */
export class GoverningGlob {
    constructor(
        readonly entry: RequiredTypeSuffixEntry,
        readonly glob: string,
    ) {}
}

/**
 * Picks the ONE entry that governs a file: the FIRST entry, in config order, with a glob matching the
 * file. Order matters — to give a narrower directory stricter suffixes, list its entry ABOVE the broader
 * one; listed below, it never applies to the files the broader entry already covers.
 */
export class SuffixEntryPicker {
    entryFor(relFile: string, entries: readonly RequiredTypeSuffixEntry[]): RequiredTypeSuffixEntry | undefined {
        return this.winner(relFile, entries)?.entry;
    }

    /** The first matching entry (and its matching glob) for `relFile`, or undefined when no entry covers it. */
    winner(relFile: string, entries: readonly RequiredTypeSuffixEntry[]): GoverningGlob | undefined {
        for (const entry of entries) {
            const glob = entry.paths.find((g: string) => matchesAnyGlob(relFile, [g]));
            if (glob !== undefined) return new GoverningGlob(entry, glob);
        }
        return undefined;
    }
}

/** The rename a failure suggests: the name's layer-less tail swapped for each allowed suffix. */
export class SuffixRename {
    /**
     * Trailing words that name no layer, dropped before a suffix is appended (`TopNamePlaceInput` →
     * `TopNamePlaceDto`, not `TopNamePlaceInputDto`). Longest first, so `Object` wins over `Obj`.
     */
    private static readonly LAYERLESS_TAILS: readonly string[] = [
        'Interface', 'Payload', 'Options', 'Object', 'Params', 'Output', 'Option', 'Record', 'Input', 'Model',
        'Entry', 'Shape', 'Data', 'Info', 'Item', 'Type', 'Body', 'Row', 'Obj',
    ];

    /** Candidate names, one per allowed suffix, in the configured order. */
    candidates(name: string, suffixes: readonly string[]): string[] {
        const stem = this.stem(name, suffixes);
        return suffixes.map((suffix: string) => `${stem}${suffix}`);
    }

    private stem(name: string, suffixes: readonly string[]): string {
        // `FooDTO` → `Foo`: the suffix is there, in the wrong case.
        const wrongCase = suffixes.find((s: string) => name.length > s.length && name.toLowerCase().endsWith(s.toLowerCase()));
        if (wrongCase !== undefined) return name.slice(0, name.length - wrongCase.length);
        // `Dto` alone → `<Name>Dto`: there is no stem to keep.
        if (suffixes.includes(name)) return '<Name>';
        const tail = SuffixRename.LAYERLESS_TAILS.find((t: string) => name.length > t.length && name.endsWith(t));
        return tail === undefined ? name : name.slice(0, name.length - tail.length);
    }
}

/** Finds every exported type in one parsed file whose name does not end in the governing entry's suffixes. */
export class ExportedTypeScanner {
    private readonly rename = new SuffixRename();

    scan(file: ApiLibFile, entry: RequiredTypeSuffixEntry, glob: string): ApiLibSite[] {
        const sites: ApiLibSite[] = [];
        const locals = new Map<string, ts.DeclarationStatement>();
        for (const statement of file.source.statements) {
            const declared = this.typeDeclaration(statement);
            if (declared === undefined) continue;
            if (this.isExported(declared)) {
                const site = this.judge(file, declared, declared.name, declared.name?.getText(file.source) ?? '', entry, glob);
                if (site !== undefined) sites.push(site);
            } else if (declared.name !== undefined) {
                locals.set(declared.name.getText(file.source), declared);
            }
        }
        sites.push(...this.exportListSites(file, locals, entry, glob));
        return sites.sort((a: ApiLibSite, b: ApiLibSite) => a.line - b.line);
    }

    /** `export { Local as Exported }` of a local type: judged by the exported name, at the specifier. */
    private exportListSites(
        file: ApiLibFile,
        locals: ReadonlyMap<string, ts.DeclarationStatement>,
        entry: RequiredTypeSuffixEntry,
        glob: string,
    ): ApiLibSite[] {
        const sites: ApiLibSite[] = [];
        for (const statement of file.source.statements) {
            if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) continue;
            if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
            for (const element of statement.exportClause.elements) {
                const local = locals.get((element.propertyName ?? element.name).getText(file.source));
                if (local === undefined) continue;
                const site = this.judge(file, local, element.name, element.name.getText(file.source), entry, glob);
                if (site !== undefined) sites.push(site);
            }
        }
        return sites;
    }

    private typeDeclaration(statement: ts.Statement): ts.DeclarationStatement | undefined {
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement) || ts.isClassDeclaration(statement)) {
            return statement;
        }
        return undefined;
    }

    private isExported(statement: ts.DeclarationStatement): boolean {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
        return modifiers.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword);
    }

    private judge(
        file: ApiLibFile,
        declared: ts.DeclarationStatement,
        at: ts.Node | undefined,
        name: string,
        entry: RequiredTypeSuffixEntry,
        glob: string,
    ): ApiLibSite | undefined {
        // `export default class { … }` has no name to judge.
        if (at === undefined || name === '') return undefined;
        if (entry.suffixes.some((suffix: string) => name.length > suffix.length && name.endsWith(suffix))) return undefined;
        const kind = this.kindOf(declared);
        const allowed = entry.suffixes.join(' | ');
        const line = file.lineOf(at);
        const snippet = (file.source.text.split('\n')[line - 1] ?? name).replace(/\s+/g, ' ').trim();
        const what = `exported ${kind} \`${name}\` does not end in a suffix allowed under ${glob} (${allowed})`;
        const candidates = this.rename.candidates(name, entry.suffixes);
        const others = candidates.slice(1).map((c: string) => `\`${c}\``).join(' / ');
        const cure = `rename ${kind} \`${name}\` → \`${candidates[0]}\`` +
            (others === '' ? '' : ` (or ${others} — pick the suffix that names its layer, e.g. …Request for an endpoint body)`) +
            ` and update every reference. Allowed suffixes under ${glob}: ${allowed} — the suffix tells a reader ` +
            `which layer the type belongs to.`;
        return new ApiLibSite(line, snippet, what, cure);
    }

    private kindOf(declared: ts.DeclarationStatement): string {
        if (ts.isInterfaceDeclaration(declared)) return 'interface';
        if (ts.isEnumDeclaration(declared)) return 'enum';
        if (ts.isTypeAliasDeclaration(declared)) return 'type';
        return 'class';
    }
}

@injectable(bindingScopeValues.Singleton)
export class RequiredTypeSuffixValidator extends ApiLibSourceRule<RequiredTypeSuffixConfig> {
    private readonly picker = new SuffixEntryPicker();
    private readonly scanner = new ExportedTypeScanner();

    constructor(config: RequiredTypeSuffixConfig, roleResolver: ProjectRoleResolver, diffScope: DiffScope) {
        super(config, RULE_NAMES.REQUIRED_TYPE_SUFFIX, roleResolver, diffScope);
    }

    protected sitesIn(file: ApiLibFile): ApiLibSite[] {
        const winner = this.picker.winner(file.relFile, this.config.entries);
        if (winner === undefined) return [];
        return this.scanner.scan(file, winner.entry, winner.glob);
    }

    /** Scoped by the configured entries' `paths` globs, not the role tag. */
    protected override isApiLibrarySource(_workspaceRoot: string, relFile: string): boolean {
        return this.picker.entryFor(relFile, this.config.entries) !== undefined;
    }

    protected override scopeLabel(): string {
        const paths = this.config.entries.flatMap((entry: RequiredTypeSuffixEntry) => entry.paths);
        return `a directory required-type-suffix governs (${paths.join(', ')})`;
    }

    protected why(): string {
        return 'every exported interface / class / enum / type there must end in one of its path\'s allowed suffixes — ' +
            'the suffix tells a reader which layer a type belongs to (a …Dto is on the wire, a …Fs is a Firestore ' +
            'document), where an unsuffixed name reads the same as a server-internal or vendor type.';
    }
}
