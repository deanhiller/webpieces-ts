type FieldType = 'string' | 'number' | 'boolean' | 'string[]';

export class FieldDef {
    constructor(
        readonly type: FieldType,
        readonly enumValues?: readonly string[],
        // When true, the field is omittable: the missing-rule snippet lists it
        // as optional rather than as a required copy-paste field.
        readonly optional: boolean = false,
    ) {}

    /** Marks a field as optional (omittable) in the config schema. */
    static optional(type: FieldType, enumValues?: readonly string[]): FieldDef {
        return new FieldDef(type, enumValues, true);
    }
}

// Enforces that a static SCHEMA has exactly the same keys as the config class.
// Add a field to the class → TS errors until SCHEMA is updated.
// Add to SCHEMA without adding to class → TS errors (extra property).
export type SchemaShape<T> = { [K in keyof Required<T>]: FieldDef };
