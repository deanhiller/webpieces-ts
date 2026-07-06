import { getDoNotRecordFields } from './DoNotRecord';

/**
 * RecordSerializer - JSON (de)serialization for recorded fixtures.
 *
 * Handles the cases plain JSON.stringify gets wrong for test fixtures:
 * - Map values -> { __type: 'Map', entries: [...] } (revived back to Map)
 * - Error values -> { __type: 'Error', name, message }
 * - Fields marked @DoNotRecord on class DTOs are omitted
 * - Dates serialize to ISO strings naturally (Date.prototype.toJSON)
 *
 * Fixtures stay diffable, human-editable JSON - the stable artifact that a
 * generated spec (or an AI writing a spec) consumes.
 */
export class RecordSerializer {
    /**
     * Serialize a recorded value/test case to pretty-printed JSON.
     */
    // webpieces-disable no-any-unknown -- serializer accepts arbitrary recorded DTOs
    serialize(value: unknown): string {
        // webpieces-disable no-any-unknown -- JSON replacer is inherently untyped
        return JSON.stringify(value, function (this: any, key: string, val: unknown): unknown {
            // `this` is the object containing `key` - consult @DoNotRecord on it
            if (key !== '' && this && typeof this === 'object' && !Array.isArray(this)) {
                const skipped = getDoNotRecordFields(this);
                if (skipped.includes(key)) {
                    return undefined;
                }
            }
            if (val instanceof Map) {
                return new SerializedMap(Array.from(val.entries()));
            }
            if (val instanceof Error) {
                return new SerializedError(val.name, val.message);
            }
            return val;
        }, 2);
    }

    /**
     * Parse fixture JSON back, reviving Map markers.
     */
    deserialize<T>(json: string): T {
        // webpieces-disable no-any-unknown -- JSON reviver is inherently untyped
        return JSON.parse(json, (key: string, val: unknown): unknown => {
            if (val && typeof val === 'object' && (val as SerializedMap).__type === 'Map') {
                return new Map((val as SerializedMap).entries);
            }
            return val;
        }) as T;
    }
}

/**
 * Wire format for Map values inside fixtures.
 */
export class SerializedMap {
    readonly __type = 'Map';
    // webpieces-disable no-any-unknown -- Map entries carry arbitrary recorded values
    constructor(public readonly entries: [unknown, unknown][]) {}
}

/**
 * Wire format for Error values inside fixtures.
 */
export class SerializedError {
    readonly __type = 'Error';
    constructor(
        public readonly name: string,
        public readonly message: string,
    ) {}
}
