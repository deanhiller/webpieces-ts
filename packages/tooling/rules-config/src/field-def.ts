type FieldType = 'string' | 'number' | 'boolean' | 'string[]';

export class FieldDef {
    constructor(
        readonly type: FieldType,
        readonly enumValues?: readonly string[],
    ) {}
}

// Enforces that a static SCHEMA has exactly the same keys as the config class.
// Add a field to the class → TS errors until SCHEMA is updated.
// Add to SCHEMA without adding to class → TS errors (extra property).
export type SchemaShape<T> = { [K in keyof Required<T>]: FieldDef };
