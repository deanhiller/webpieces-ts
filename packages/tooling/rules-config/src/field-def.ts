// `object[]` is a list of JSON objects, each validated against the field's `elementSchema` (e.g.
// required-type-suffix's `entries`: `[{ "paths": [...], "suffixes": [...] }]`).
type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'object[]';

export class FieldDef {
    constructor(
        readonly type: FieldType,
        readonly enumValues?: readonly string[],
        // When true, the field is omittable: the missing-rule snippet lists it
        // as optional rather than as a required copy-paste field.
        readonly optional: boolean = false,
        // When true, JSON `null` is an accepted value in addition to `type`. Used for a REQUIRED
        // field whose "unset" state must still be visible in the config (e.g. turnOffRuleWhileOnBranch:
        // null means "no branch / always on") — required so it is always present, nullable so it can be
        // present-but-unset without inventing a sentinel string.
        readonly nullable: boolean = false,
        // When true, an array field (`string[]` / `object[]`) must hold at least one element — for a list
        // whose emptiness would mean "judge nothing" while reading as "configured".
        readonly nonEmpty: boolean = false,
        // For `object[]` only: the schema EVERY element is validated against (unknown keys, missing
        // required keys, types, non-emptiness), exactly like a rule entry's own fields.
        readonly elementSchema?: Readonly<Record<string, FieldDef>>,
    ) {}

    /** Marks a field as optional (omittable) in the config schema. */
    static optional(type: FieldType, enumValues?: readonly string[]): FieldDef {
        return new FieldDef(type, enumValues, true);
    }

    /** A REQUIRED string field that also accepts `null` (present-but-unset). */
    // webpieces-disable no-function-outside-class -- static factory, matches sibling FieldDef.optional
    static nullableString(): FieldDef {
        return new FieldDef('string', undefined, false, true);
    }

    /** A REQUIRED `string[]` that must hold at least one string. */
    // webpieces-disable no-function-outside-class -- static factory, matches sibling FieldDef.optional
    static nonEmptyStrings(): FieldDef {
        return new FieldDef('string[]', undefined, false, false, true);
    }

    /** A REQUIRED, non-empty list of objects, each validated against `elementSchema`. */
    // webpieces-disable no-function-outside-class -- static factory, matches sibling FieldDef.optional
    static nonEmptyObjects(elementSchema: Readonly<Record<string, FieldDef>>): FieldDef {
        return new FieldDef('object[]', undefined, false, false, true, elementSchema);
    }
}

// Enforces that a static SCHEMA has exactly the same keys as the config class.
// Add a field to the class → TS errors until SCHEMA is updated.
// Add to SCHEMA without adding to class → TS errors (extra property).
export type SchemaShape<T> = { [K in keyof Required<T>]: FieldDef };
