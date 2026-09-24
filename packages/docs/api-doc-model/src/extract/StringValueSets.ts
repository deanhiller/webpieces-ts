import { DocumentedField, DocumentedType, UnionDiscriminator } from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';

/**
 * CLOSED sets of string values among resolved types — the part of {@link TypeResolver} that decides
 * when a union is an ENUM (every branch a string value: a literal, a string-enum member, a whole string
 * enum) and when a union of objects has a DERIVED discriminator (#1023).
 *
 * Reads the named types registered so far; it registers nothing itself.
 */
export class StringValueSets {
    constructor(private readonly types: ReadonlyMap<string, DocumentedType>) {}

    /**
     * The DERIVED discriminator: the property every branch declares as string VALUES — one string
     * literal or string-enum member (`mode: 'fixed'`, `mode: VoiceMode.FIXED`), or a union of them
     * (`mode: 'a' | 'b'`, #1023) — with no value claimed by two branches. That is exactly the shape
     * TypeScript narrows on, and an OpenAPI `mapping` can point several values at one branch.
     * Derived, never invented — if the source does not narrow, neither does the document.
     */
    derive(branchNames: readonly string[]): UnionDiscriminator | undefined {
        const branches = branchNames.map((name: string) => this.types.get(name));
        if (branches.some((b: DocumentedType | undefined) => b === undefined)) {
            return undefined;
        }
        for (const field of branches[0]!.fields) {
            const discriminator = this.discriminatorOn(
                field.name,
                branchNames,
                branches as DocumentedType[],
            );
            if (discriminator !== undefined) {
                return discriminator;
            }
        }
        return undefined;
    }

    /** `propertyName` as the discriminator of these branches, or undefined when it cannot be one. */
    private discriminatorOn(
        propertyName: string,
        branchNames: readonly string[],
        branches: readonly DocumentedType[],
    ): UnionDiscriminator | undefined {
        const byBranch = new Map<string, readonly string[]>();
        const claimed = new Set<string>();
        for (let i = 0; i < branches.length; i++) {
            const candidate = branches[i]!.fields.find(
                (f: DocumentedField) => f.name === propertyName,
            );
            const values = candidate === undefined ? undefined : this.valuesOf(candidate.type);
            if (values === undefined || values.some((value: string) => claimed.has(value))) {
                return undefined;
            }
            values.forEach((value: string) => claimed.add(value));
            byBranch.set(branchNames[i]!, values);
        }
        return new UnionDiscriminator(propertyName, byBranch);
    }

    /**
     * The string values a resolved type can hold, when it is a CLOSED set of strings: an inline enum
     * (a literal, a literal union, an enum member) or a `$ref` to a named string enum. Undefined for
     * anything else.
     */
    valuesOf(ref: TypeRef): readonly string[] | undefined {
        if (ref.kind === 'enum') {
            return ref.enumValues.length > 0 ? ref.enumValues : undefined;
        }
        if (ref.kind === 'ref') {
            const named = this.types.get(ref.refName!);
            return named !== undefined && named.enumValues.length > 0
                ? named.enumValues
                : undefined;
        }
        return undefined;
    }

    /** Every branch's string values merged in declaration order, or undefined when one is not a string set. */
    valuesOfAll(refs: readonly TypeRef[]): readonly string[] | undefined {
        const merged: string[] = [];
        for (const ref of refs) {
            const values = this.valuesOf(ref);
            if (values === undefined) {
                return undefined;
            }
            for (const value of values) {
                if (!merged.includes(value)) merged.push(value);
            }
        }
        return merged;
    }
}
