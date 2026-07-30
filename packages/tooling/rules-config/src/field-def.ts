type FieldType = 'string' | 'number' | 'boolean' | 'string[]';

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
}

// Enforces that a static SCHEMA has exactly the same keys as the config class.
// Add a field to the class → TS errors until SCHEMA is updated.
// Add to SCHEMA without adding to class → TS errors (extra property).
export type SchemaShape<T> = { [K in keyof Required<T>]: FieldDef };
