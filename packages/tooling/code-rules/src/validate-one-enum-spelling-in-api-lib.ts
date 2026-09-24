/**
 * `one-enum-spelling-in-api-lib` (#1023) — ONE spelling for a fixed set of string values in an API:
 *
 *   export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }
 *   gender!: SpeakerGender;                 // the enum
 *   mode: VoiceMode.RANDOM;                 // one member (a union discriminator)
 *   mode: VoiceMode.A | VoiceMode.B;        // a union of members
 *
 * In every `role:api-lib` project this refuses, each with a cure that PRINTS the enum to write:
 *
 *   type LessonType = 'story' | 'lesson';   kind?: 'audio' | 'slot';   (a 2+ string-literal union)
 *   gender!: (typeof SPEAKER_GENDERS)[number];   key: keyof typeof LABELS;
 *   mode: 'random';                          (a single literal used as a union discriminator)
 *   enum Level { LOW, HIGH }   enum Mixed { A = 'a', B = 2 }   const enum Tone { … }
 *
 * Why ONE spelling: two ways to write a closed set means every reader, reviewer and the document
 * generator has to understand both, and the derived spellings (`(typeof X)[number]`, a `string` field
 * whose legal values live in some array) are exactly the ones the generator does not read — they can
 * only be supported later, deliberately, if ever. A numeric enum puts NUMBERS on the wire, which no
 * partner reading `gender: 1` can interpret. The generator itself keeps supporting literal unions;
 * this rule is what forbids new ones in an api library.
 */

import { DiffScope, OneEnumSpellingInApiLibConfig, RULE_NAMES } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import * as ts from 'typescript';
import { ApiLibEnumIndex, ObjectUnion } from './api-lib-enum-index';
import { EnumText } from './api-lib-enum-text';
import { ApiLibFile, ApiLibSite, ApiLibSourceRule } from './api-lib-source-rule';
import { ProjectRoleResolver } from './project-role-resolver';

const ONE_SPELLING = 'a fixed set of string values in an API is a string enum, and only a string enum';

/** Where a type is written: the declaration that names it, for naming the enum. Data-only. */
class Holder {
    constructor(
        /** 'alias' | 'property' | 'parameter' | 'none'. */
        readonly kind: string,
        readonly name: string,
        /** The enclosing named type / class / function, when there is one. */
        readonly owner: string | undefined,
    ) {}
}

/** A property that discriminates a union, and every value the union's branches give it. Data-only. */
class Discriminator {
    constructor(
        readonly enumName: string,
        readonly values: readonly string[],
    ) {}
}

/** Finds every non-enum spelling of a closed string set in one parsed file. */
export class EnumSpellingScanner {
    scan(file: ApiLibFile, index: ApiLibEnumIndex): ApiLibSite[] {
        const sites: ApiLibSite[] = [];
        const visit = (node: ts.Node): void => {
            const site = this.siteAt(file, index, node);
            if (site !== undefined) sites.push(site);
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return sites;
    }

    private siteAt(file: ApiLibFile, index: ApiLibEnumIndex, node: ts.Node): ApiLibSite | undefined {
        if (ts.isUnionTypeNode(node)) return this.literalUnion(file, index, node);
        if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return this.singleLiteral(file, index, node);
        if (ts.isIndexedAccessTypeNode(node)) return this.typeofIndex(file, index, node);
        if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword) return this.keyofTypeof(file, index, node);
        if (ts.isEnumDeclaration(node)) return this.badEnum(file, node);
        return undefined;
    }

    /** `'a' | 'b'` — two or more string-literal branches, anywhere a type is written. */
    private literalUnion(file: ApiLibFile, index: ApiLibEnumIndex, node: ts.UnionTypeNode): ApiLibSite | undefined {
        const values = node.types
            .filter((t: ts.TypeNode) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
            .map((t: ts.TypeNode) => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text);
        if (values.length < 2) return undefined;
        const holder = this.holderOf(node);
        const discriminator = this.discriminatorOf(index, holder);
        const what = `a string-literal union — ${ONE_SPELLING}`;
        if (discriminator !== undefined) {
            const members = values.map((v: string) => EnumText.memberRef(discriminator.enumName, v, discriminator.values)).join(' | ');
            return file.site(node, what,
                `declare \`${EnumText.declaration(discriminator.enumName, discriminator.values)}\` (every value of the ` +
                    `\`${holder.name}\` discriminator) and write \`${holder.name}: ${members}\` here.`);
        }
        if (holder.kind === 'alias') {
            return file.site(node, what,
                `replace \`type ${holder.name} = …\` with \`${EnumText.declaration(holder.name, values)}\` — every use of ` +
                    `${holder.name} as a type keeps compiling; a literal VALUE becomes ${EnumText.memberRef(holder.name, values[0]!, values)}.`);
        }
        const name = this.enumNameFor(holder);
        return file.site(node, what,
            `declare \`${EnumText.declaration(name, values)}\` and write \`${name}\` here in place of the union.`);
    }

    /** `mode: 'random'` on a branch of a union — a discriminator, which is one enum member. */
    private singleLiteral(file: ApiLibFile, index: ApiLibEnumIndex, node: ts.LiteralTypeNode): ApiLibSite | undefined {
        const direct = node.parent;
        const property = ts.isUnionTypeNode(direct) ? direct.parent : direct;
        if (!ts.isPropertySignature(property) && !ts.isPropertyDeclaration(property)) return undefined;
        if (ts.isUnionTypeNode(direct) && direct.types.filter((t: ts.TypeNode) => !ApiLibEnumIndex.isNullish(t)).length !== 1) {
            return undefined;
        }
        const discriminator = this.discriminatorOf(index, this.holderOf(node));
        if (discriminator === undefined) return undefined;
        const value = (node.literal as ts.StringLiteral).text;
        const key = property.name.getText(file.source);
        return file.site(node, `a single string-literal discriminator — ${ONE_SPELLING}`,
            `declare \`${EnumText.declaration(discriminator.enumName, discriminator.values)}\` (every value of the ` +
                `\`${key}\` discriminator) and write \`${key}: ${EnumText.memberRef(discriminator.enumName, value, discriminator.values)}\` here.`);
    }

    /** `(typeof X)[number]` — the values live in a runtime list; the enum IS that list. */
    private typeofIndex(file: ApiLibFile, index: ApiLibEnumIndex, node: ts.IndexedAccessTypeNode): ApiLibSite | undefined {
        let object: ts.TypeNode = node.objectType;
        while (ts.isParenthesizedTypeNode(object)) object = object.type;
        if (!ts.isTypeQueryNode(object) || node.indexType.kind !== ts.SyntaxKind.NumberKeyword) return undefined;
        const list = object.exprName.getText(file.source);
        const name = EnumText.singularPascal(list.split('.').pop() ?? list);
        const values = index.constList(list);
        const declaration = values === undefined
            ? `export enum ${name} { /* one MEMBER = 'value' per element of ${list} */ }`
            : EnumText.declaration(name, values);
        return file.site(node, `\`(typeof ${list})[number]\` — ${ONE_SPELLING}`,
            `replace \`${list}\` with \`${declaration}\` and write \`${name}\` here; code that needs the runtime ` +
                `list uses \`Object.values(${name})\`.`);
    }

    /** `keyof typeof X` — the values are an object's keys; the enum states them. */
    private keyofTypeof(file: ApiLibFile, index: ApiLibEnumIndex, node: ts.TypeOperatorNode): ApiLibSite | undefined {
        if (!ts.isTypeQueryNode(node.type)) return undefined;
        const object = node.type.exprName.getText(file.source);
        const name = `${EnumText.pascal(object.split('.').pop() ?? object)}Key`;
        const keys = index.constKeysOf(object);
        const declaration = keys === undefined
            ? `export enum ${name} { /* one MEMBER = 'key' per key of ${object} */ }`
            : EnumText.declaration(name, keys);
        return file.site(node, `\`keyof typeof ${object}\` — ${ONE_SPELLING}`,
            `declare \`${declaration}\` and write \`${name}\` here (key ${object} by it: \`Record<${name}, …>\`).`);
    }

    /** A `const`, numeric, heterogeneous or uninitialised enum. */
    private badEnum(file: ApiLibFile, node: ts.EnumDeclaration): ApiLibSite | undefined {
        const isConst = (node.modifiers ?? []).some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ConstKeyword);
        const bad = node.members.filter((m: ts.EnumMember) => m.initializer === undefined || !ts.isStringLiteral(m.initializer));
        if (!isConst && bad.length === 0) return undefined;
        const values = node.members.map((m: ts.EnumMember) =>
            m.initializer !== undefined && ts.isStringLiteral(m.initializer) ? m.initializer.text : EnumText.valueFor(m.name.getText(file.source)));
        const reason = isConst
            ? 'a `const enum` — it is erased at compile time, so no runtime value exists for a client or the generator to read'
            : `member(s) ${bad.map((m: ts.EnumMember) => m.name.getText(file.source)).join(', ')} are not initialised with a string ` +
                'literal — a numeric enum puts NUMBERS on the wire';
        const members = node.members.map((m: ts.EnumMember, i: number) => `${m.name.getText(file.source)} = '${values[i]}'`).join(', ');
        return file.site(node.name, `${reason}; ${ONE_SPELLING}`,
            `write \`export enum ${node.name.text} { ${members} }\` — every member string-initialised, no \`const\` ` +
                '(the suggested values are a starting point: they are the wire format, so choose them deliberately).');
    }

    /** The declaration a written type belongs to — climbing through arrays, parens, unions and generics. */
    private holderOf(node: ts.Node): Holder {
        let current: ts.Node = node.parent;
        while (current !== undefined && ts.isTypeNode(current)) current = current.parent;
        if (current === undefined) return new Holder('none', 'Values', undefined);
        if (ts.isTypeAliasDeclaration(current)) return new Holder('alias', current.name.text, undefined);
        if ((ts.isPropertySignature(current) || ts.isPropertyDeclaration(current)) &&
            (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))) {
            return new Holder('property', current.name.text, this.ownerOf(current));
        }
        if (ts.isParameter(current) && ts.isIdentifier(current.name)) {
            return new Holder('parameter', current.name.text, this.ownerOf(current));
        }
        return new Holder('none', 'Values', this.ownerOf(current));
    }

    /** The nearest enclosing named interface, class, type alias or function. */
    private ownerOf(node: ts.Node): string | undefined {
        for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
            if ((ts.isInterfaceDeclaration(at) || ts.isClassDeclaration(at) || ts.isTypeAliasDeclaration(at) ||
                ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined && ts.isIdentifier(at.name)) {
                return at.name.text;
            }
        }
        return undefined;
    }

    /**
     * When the holder is a property of a union BRANCH that every branch declares, it discriminates the
     * union: the enum is named for the union and property, and holds every branch's values.
     */
    private discriminatorOf(index: ApiLibEnumIndex, holder: Holder): Discriminator | undefined {
        if (holder.kind !== 'property' || holder.owner === undefined) return undefined;
        const union = index.unionsOf(holder.owner)
            .find((u: ObjectUnion) => u.branches.every((b: string) => index.propertyOf(b, holder.name) !== undefined));
        if (union === undefined) return undefined;
        const values: string[] = [];
        for (const branch of union.branches) {
            for (const value of this.literalValues(index.propertyOf(branch, holder.name)!)) {
                if (!values.includes(value)) values.push(value);
            }
        }
        return new Discriminator(`${union.name ?? holder.owner}${EnumText.pascal(holder.name)}`, values);
    }

    /** The string literals a property type spells: `'a'` or `'a' | 'b'`. */
    private literalValues(type: ts.TypeNode): string[] {
        const branches = ts.isUnionTypeNode(type) ? [...type.types] : [type];
        return branches
            .filter((t: ts.TypeNode) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
            .map((t: ts.TypeNode) => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text);
    }

    private enumNameFor(holder: Holder): string {
        if (holder.kind === 'none') return `${holder.owner === undefined ? '' : EnumText.pascal(holder.owner)}Values`;
        return `${holder.owner === undefined ? '' : EnumText.pascal(holder.owner)}${EnumText.pascal(holder.name)}`;
    }
}

@injectable(bindingScopeValues.Singleton)
export class OneEnumSpellingInApiLibValidator extends ApiLibSourceRule<OneEnumSpellingInApiLibConfig> {
    private readonly scanner = new EnumSpellingScanner();
    /** One index per api-library directory, per run: the union and its branches are in different files. */
    private readonly indexes = new Map<string, ApiLibEnumIndex>();

    constructor(config: OneEnumSpellingInApiLibConfig, roleResolver: ProjectRoleResolver, diffScope: DiffScope) {
        super(config, RULE_NAMES.ONE_ENUM_SPELLING_IN_API_LIB, roleResolver, diffScope);
    }

    protected sitesIn(file: ApiLibFile): ApiLibSite[] {
        let index = this.indexes.get(file.projectDir);
        if (index === undefined) {
            index = ApiLibEnumIndex.of(file.projectDir);
            this.indexes.set(file.projectDir, index);
        }
        return this.scanner.scan(file, index);
    }

    protected why(): string {
        return `${ONE_SPELLING} — every member explicitly initialised with a string literal. Two spellings of one ` +
            'thing is two things every reader and the document generator must understand, and a numeric enum puts ' +
            'numbers on the wire.';
    }
}
