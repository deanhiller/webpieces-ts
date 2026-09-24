/**
 * What `one-enum-spelling-in-api-lib` needs to know about a WHOLE api library before it can judge one
 * of its files (#1023): which object types are branches of a union (so a literal-typed property on one
 * is a DISCRIMINATOR), what each named object type declares, and the values of the `as const` lists
 * and objects a `(typeof X)[number]` / `keyof typeof X` reads — so the cure can print the enum with its
 * real values rather than a placeholder.
 *
 * Built once per project directory and cached: the union and the branch it names are routinely in
 * different files. Parser-only, like the rule.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** One union of named object types, e.g. `type StoryVoiceChoice = A | B | C`. Data-only. */
export class ObjectUnion {
    constructor(
        /** The alias name, or undefined for a union written inline on a field. */
        readonly name: string | undefined,
        readonly branches: readonly string[],
    ) {}
}

/** Directories never part of an api library's source. */
const SKIPPED_DIRS: readonly string[] = ['node_modules', 'dist', '.nx', '__tests__'];

export class ApiLibEnumIndex {
    /** branch type name -> the unions it is a branch of. */
    private readonly unionsByBranch = new Map<string, ObjectUnion[]>();
    /** named object type -> its properties' declared type nodes. */
    private readonly properties = new Map<string, Map<string, ts.TypeNode>>();
    /** `const X = ['a', 'b'] as const` -> ['a', 'b']. */
    private readonly constLists = new Map<string, string[]>();
    /** `const X = { a: …, b: … } as const` -> ['a', 'b']. */
    private readonly constKeys = new Map<string, string[]>();

    /** Index every non-test `.ts` file under `projectDir`. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static of(projectDir: string): ApiLibEnumIndex {
        const index = new ApiLibEnumIndex();
        for (const file of ApiLibEnumIndex.sourceFiles(projectDir)) {
            const text = fs.readFileSync(file, 'utf8');
            index.add(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
        }
        return index;
    }

    /** Add one parsed file — also how a spec builds an index from source text. */
    add(source: ts.SourceFile): void {
        const visit = (node: ts.Node): void => {
            this.indexNode(node);
            ts.forEachChild(node, visit);
        };
        visit(source);
    }

    unionsOf(branch: string): readonly ObjectUnion[] {
        return this.unionsByBranch.get(branch) ?? [];
    }

    propertyOf(typeName: string, property: string): ts.TypeNode | undefined {
        return this.properties.get(typeName)?.get(property);
    }

    constList(name: string): readonly string[] | undefined {
        return this.constLists.get(name);
    }

    constKeysOf(name: string): readonly string[] | undefined {
        return this.constKeys.get(name);
    }

    private indexNode(node: ts.Node): void {
        if (ts.isUnionTypeNode(node)) this.indexUnion(node);
        if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
            this.indexMembers(node.name.text, node.members);
        }
        if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
            this.indexMembers(node.name.text, node.type.members);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
            this.indexConst(node.name.text, node.initializer);
        }
    }

    /** A union whose non-nullish branches are all NAMED types, two or more of them. */
    private indexUnion(node: ts.UnionTypeNode): void {
        const names: string[] = [];
        for (const branch of node.types) {
            if (ApiLibEnumIndex.isNullish(branch)) continue;
            if (!ts.isTypeReferenceNode(branch) || !ts.isIdentifier(branch.typeName)) return;
            names.push(branch.typeName.text);
        }
        if (names.length < 2) return;
        const union = new ObjectUnion(ts.isTypeAliasDeclaration(node.parent) ? node.parent.name.text : undefined, names);
        for (const name of names) {
            const list = this.unionsByBranch.get(name) ?? [];
            list.push(union);
            this.unionsByBranch.set(name, list);
        }
    }

    private indexMembers(owner: string, members: ts.NodeArray<ts.TypeElement> | ts.NodeArray<ts.ClassElement>): void {
        const byName = this.properties.get(owner) ?? new Map<string, ts.TypeNode>();
        for (const member of members) {
            if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) continue;
            if (member.type === undefined || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
            byName.set(member.name.text, member.type);
        }
        this.properties.set(owner, byName);
    }

    /** `[...] as const` string lists and `{...} as const` objects. */
    private indexConst(name: string, initializer: ts.Expression): void {
        const inner = ts.isAsExpression(initializer) ? initializer.expression : initializer;
        if (ts.isArrayLiteralExpression(inner)) {
            const values = inner.elements.filter(ts.isStringLiteralLike).map((each: ts.StringLiteralLike) => each.text);
            if (values.length === inner.elements.length) this.constLists.set(name, values);
            return;
        }
        if (ts.isObjectLiteralExpression(inner)) {
            const keys: string[] = [];
            for (const property of inner.properties) {
                const key = property.name;
                if (key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key))) keys.push(key.text);
            }
            this.constKeys.set(name, keys);
        }
    }

    // webpieces-disable no-function-outside-class -- private static predicate of this class
    static isNullish(node: ts.TypeNode): boolean {
        if (node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
        return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
    }

    // webpieces-disable no-function-outside-class -- private static file walk of this class
    private static sourceFiles(dir: string): string[] {
        const files: string[] = [];
        if (!fs.existsSync(dir)) return files;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.includes(entry.name)) files.push(...ApiLibEnumIndex.sourceFiles(full));
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !/\.(spec|test)\.ts$/.test(entry.name)) {
                files.push(full);
            }
        }
        return files;
    }
}
