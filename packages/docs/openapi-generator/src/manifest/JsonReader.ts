import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * A narrowing reader over ONE parsed JSON object.
 *
 * ## Why this class exists at all
 *
 * `JSON.parse` returns something with no shape, and a loader that passed that shapelessness around
 * would spread it over every method that touches the manifest. Concentrating it HERE means the rest
 * of the package deals only in `string`, `JsonReader` and the manifest classes — and it means the
 * "this value came off disk and has not been checked yet" state exists in exactly one file, where a
 * reader can see every check that state is subjected to.
 *
 * ## Every miss is a HARD FAILURE naming the field
 *
 * There is deliberately no defaulting of anything a reader would notice. A published document quietly
 * missing a section is indistinguishable, from the outside, from an API that genuinely has no error
 * contract — so a mistyped `errors` must stop the run rather than silently publish less.
 */
export class JsonReader {
    private constructor(
        // webpieces-disable no-any-unknown -- parsed JSON is genuinely shapeless until the accessors below narrow it; this is the ONE place that state exists
        private readonly entries: ReadonlyMap<string, unknown>,
        /** The file this came from, so every failure names something somebody can open. */
        readonly where: string,
    ) {}

    /** Parse a whole file. */
    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what keeps unchecked JSON out of every other file
    static parseFile(text: string, where: string): JsonReader {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- re-thrown as the ONE error type of this package, with its cure
        try {
            // webpieces-disable no-any-unknown -- JSON.parse's result, before anything has narrowed it
            const parsed: unknown = JSON.parse(text);
            return JsonReader.of(parsed, where, 'the manifest');
        } catch (err: unknown) {
            //const error = toError(err);
            if (err instanceof OpenApiGenerationError) {
                throw err;
            }
            throw new OpenApiGenerationError(
                `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
                where,
                'Fix the JSON syntax. The manifest is read before anything else runs.',
            );
        }
    }

    /** One already-parsed value that must be an object. */
    // webpieces-disable no-any-unknown -- the value has not been narrowed yet; that is this method's job
    // webpieces-disable no-function-outside-class -- static factory of this class
    private static of(value: unknown, where: string, what: string): JsonReader {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new OpenApiGenerationError(
                `${what} is not a JSON object`,
                where,
                'Write it as a JSON object — one `{ ... }` with named fields.',
            );
        }
        return new JsonReader(new Map(Object.entries(value)), where);
    }

    has(field: string): boolean {
        return this.entries.get(field) !== undefined;
    }

    /** A required, non-empty string. */
    string(field: string): string {
        const value = this.optionalString(field);
        if (value === undefined) {
            throw new OpenApiGenerationError(
                `'${field}' is missing or is not a non-empty string`,
                this.where,
                `Give "${field}" a value; an empty one publishes a document nobody can identify.`,
            );
        }
        return value;
    }

    optionalString(field: string): string | undefined {
        // webpieces-disable no-any-unknown -- the raw entry, narrowed on the next line
        const value: unknown = this.entries.get(field);
        return typeof value === 'string' && value !== '' ? value : undefined;
    }

    /** An array of strings, empty when the field is absent. */
    strings(field: string): readonly string[] {
        // webpieces-disable no-any-unknown -- the raw entry, narrowed below
        const value: unknown = this.entries.get(field);
        if (value === undefined) {
            return [];
        }
        // webpieces-disable no-any-unknown -- element of a not-yet-narrowed array
        if (!Array.isArray(value) || value.some((each: unknown) => typeof each !== 'string')) {
            throw new OpenApiGenerationError(
                `'${field}' is not an array of strings`,
                this.where,
                `Write "${field}" as a JSON array of strings, or leave it out.`,
            );
        }
        return value as readonly string[];
    }

    /** A nested object, or undefined when the field is absent. */
    object(field: string): JsonReader | undefined {
        // webpieces-disable no-any-unknown -- the raw entry, narrowed by `of`
        const value: unknown = this.entries.get(field);
        return value === undefined ? undefined : JsonReader.of(value, this.where, `'${field}'`);
    }

    /** An array of objects, empty when the field is absent. */
    objects(field: string): readonly JsonReader[] {
        // webpieces-disable no-any-unknown -- the raw entry, narrowed below
        const value: unknown = this.entries.get(field);
        if (value === undefined) {
            return [];
        }
        if (!Array.isArray(value)) {
            throw new OpenApiGenerationError(
                `'${field}' is not an array`,
                this.where,
                `Write "${field}" as a JSON array, or leave it out.`,
            );
        }
        // webpieces-disable no-any-unknown -- element of a not-yet-narrowed array
        return value.map((each: unknown) =>
            JsonReader.of(each, this.where, `an entry of '${field}'`),
        );
    }
}
