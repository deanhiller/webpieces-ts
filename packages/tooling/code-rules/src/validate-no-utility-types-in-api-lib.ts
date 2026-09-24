/**
 * `no-utility-types-in-api-lib` (#1026) — an API contract writes its fields out.
 *
 * In every `.ts` file under the configured `paths` (e.g. `libraries/apis/**`) this refuses the
 * utility types that turn a DTO's field list, or a set of keys, into a type-level computation:
 *
 *   export interface LessonPassageDto extends Omit<LessonPassageReservationDto, OptionalField> { … }
 *   draft?: Partial<LessonDto>;
 *   export type Summary = Pick<LessonDto, 'id' | 'title'>;
 *   export type Kind = Exclude<AllKinds, 'legacy'>;
 *
 * — `Omit`, `Pick`, `Partial`, `Required`, `Exclude` and `Extract`, in an `extends` / `implements`
 * clause, a field, a type alias or a generic argument.
 *
 * Why: an api library is the contract every client, server and document generator reads. A utility
 * type makes a reader open a second file and subtract (or add) names in their head to learn which
 * fields a DTO carries; it cannot become a DTO class (`class X extends Omit<…>` does not compile — a
 * utility type has no runtime value); and a key union that only exists to feed `Omit` collides with
 * `one-enum-spelling-in-api-lib`, whose enum cure removes nothing from an `Omit`. The whole family is
 * refused, not `Omit` alone, because banning one just moves the computation into its sibling
 * (`Pick<T, Exclude<keyof T, K>>` is `Omit<T, K>`). `Record`, `Readonly` and `Array` stay allowed:
 * they do not hide which fields a DTO carries.
 *
 * The cure is to write the fields out — a shared base interface both DTOs extend, each adding its own
 * required or optional fields, or a flat interface / class listing every field. The wire JSON is
 * unchanged either way.
 */

import { DiffScope, NoUtilityTypesInApiLibConfig, RULE_NAMES, matchesAnyGlob } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import * as ts from 'typescript';
import { ApiLibFile, ApiLibSite, ApiLibSourceRule } from './api-lib-source-rule';
import { ProjectRoleResolver } from './project-role-resolver';

/** Finds every refused utility-type reference in one parsed file. */
export class UtilityTypeScanner {
    /** The refused utility types, each with what it computes. */
    static readonly REFUSED: ReadonlyMap<string, string> = new Map<string, string>([
        ['Omit', 'a DTO\'s field list computed by SUBTRACTING keys from another type'],
        ['Pick', 'a DTO\'s field list computed by SELECTING keys of another type'],
        ['Partial', 'a DTO\'s field list computed by making every field of another type optional'],
        ['Required', 'a DTO\'s field list computed by making every field of another type required'],
        ['Exclude', 'a set of keys or values computed by SUBTRACTING from another union'],
        ['Extract', 'a set of keys or values computed by SELECTING from another union'],
    ]);

    scan(file: ApiLibFile): ApiLibSite[] {
        const shadowed = this.locallyDeclaredNames(file.source);
        const sites: ApiLibSite[] = [];
        const visit = (node: ts.Node): void => {
            const name = this.refusedNameOf(node, shadowed);
            if (name !== undefined) sites.push(this.siteFor(file, node, name));
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return sites;
    }

    /** The utility's name when `node` is a refused reference: `Omit<…>` as a type, or in a heritage clause. */
    private refusedNameOf(node: ts.Node, shadowed: ReadonlySet<string>): string | undefined {
        let name: string | undefined;
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) name = node.typeName.text;
        else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) name = node.expression.text;
        if (name === undefined || !UtilityTypeScanner.REFUSED.has(name) || shadowed.has(name)) return undefined;
        return name;
    }

    /**
     * Names the file declares or imports itself — a local `type Omit = …` or an imported `Pick` class
     * is not the global utility type, so it is not refused.
     */
    private locallyDeclaredNames(source: ts.SourceFile): Set<string> {
        const names = new Set<string>();
        for (const statement of source.statements) {
            if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
                ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name !== undefined) {
                names.add(statement.name.text);
            }
            const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
            if (bindings !== undefined && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) names.add(element.name.text);
            }
        }
        return names;
    }

    private siteFor(file: ApiLibFile, node: ts.Node, name: string): ApiLibSite {
        const args = this.typeArgumentsOf(node).map((arg: ts.TypeNode) => arg.getText(file.source).replace(/\s+/g, ' '));
        const what = `\`${name}<…>\` — ${UtilityTypeScanner.REFUSED.get(name)}; an API writes its fields out`;
        return file.site(node, what, `${this.cureFor(name, args[0] ?? 'T', args[1] ?? 'K')} ${this.owner(file, node)}`.trim());
    }

    private typeArgumentsOf(node: ts.Node): readonly ts.TypeNode[] {
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) return node.typeArguments ?? [];
        return [];
    }

    private cureFor(name: string, target: string, keys: string): string {
        const wire = 'The wire JSON is unchanged.';
        switch (name) {
            case 'Omit':
                return `write the fields out instead of \`Omit<${target}, ${keys}>\`: move the fields both types share into a ` +
                    `base interface that ${target} and this type both extend, each adding its own required or optional ` +
                    `fields — or list every field of ${target} except ${keys} in a flat interface or class. ${wire}`;
            case 'Pick':
                return `write the fields out instead of \`Pick<${target}, ${keys}>\`: put the picked fields (${keys}) in a ` +
                    `base interface that ${target} extends and use it here — or list them in a flat interface or class. ${wire}`;
            case 'Partial':
                return `write the fields out instead of \`Partial<${target}>\`: declare an interface or class listing every ` +
                    `field of ${target} as optional (\`field?: X\`). ${wire}`;
            case 'Required':
                return `write the fields out instead of \`Required<${target}>\`: declare an interface or class listing every ` +
                    `field of ${target} as required. ${wire}`;
            default:
                return `write the set out instead of \`${name}<${target}, ${keys}>\`: for keys of a DTO, write that DTO's ` +
                    `fields out; for values, declare the string enum holding exactly the members meant ` +
                    `(one-enum-spelling-in-api-lib), or a union of its members. ${wire}`;
        }
    }

    /** `(on interface X)` for a heritage clause, `(in X.field)` for a member, `(in type X)` for an alias. */
    private owner(file: ApiLibFile, node: ts.Node): string {
        let current: ts.Node | undefined = node.parent;
        let member: string | undefined;
        while (current !== undefined && current !== file.source) {
            if ((ts.isPropertySignature(current) || ts.isPropertyDeclaration(current)) && member === undefined) {
                member = current.name.getText(file.source);
            }
            const declared = this.declaredName(current);
            if (declared !== undefined) {
                if (ts.isHeritageClause(node.parent)) return `(on ${declared})`;
                return member === undefined ? `(in ${declared})` : `(in ${declared}.${member})`;
            }
            current = current.parent;
        }
        return '';
    }

    private declaredName(node: ts.Node): string | undefined {
        if (ts.isInterfaceDeclaration(node)) return `interface ${node.name.text}`;
        if (ts.isClassDeclaration(node) && node.name !== undefined) return `class ${node.name.text}`;
        if (ts.isTypeAliasDeclaration(node)) return `type ${node.name.text}`;
        return undefined;
    }
}

@injectable(bindingScopeValues.Singleton)
export class NoUtilityTypesInApiLibValidator extends ApiLibSourceRule<NoUtilityTypesInApiLibConfig> {
    private readonly scanner = new UtilityTypeScanner();

    constructor(config: NoUtilityTypesInApiLibConfig, roleResolver: ProjectRoleResolver, diffScope: DiffScope) {
        super(config, RULE_NAMES.NO_UTILITY_TYPES_IN_API_LIB, roleResolver, diffScope);
    }

    protected sitesIn(file: ApiLibFile): ApiLibSite[] {
        return this.scanner.scan(file);
    }

    /** Scoped by the configured `paths` globs, not the role tag — an empty list judges nothing. */
    protected override isApiLibrarySource(_workspaceRoot: string, relFile: string): boolean {
        return matchesAnyGlob(relFile, this.config.paths);
    }

    protected override scopeLabel(): string {
        return `an API contract library (paths: ${this.config.paths.join(', ')})`;
    }

    protected why(): string {
        return 'an API writes its fields out — Omit / Pick / Partial / Required / Exclude / Extract make every reader ' +
            'of the contract compute its field list from another file, and none of them can become a DTO class.';
    }
}
