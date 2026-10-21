/** Everything a JSON document can hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonMap;

/** The object case of {@link JsonValue}. */
export type JsonMap = { [key: string]: JsonValue };

/**
 * A total READER over one JSON value: every accessor answers `undefined` (or empty) for an absent
 * or wrongly-shaped key instead of throwing, so the importer decides what is fatal — not the parser.
 * Read structurally, because the vendor's document was written by a tool we do not own.
 */
export class SpecNode {
    // webpieces-disable no-any-unknown -- the document is FOREIGN input; narrowing it is this class's whole job
    constructor(readonly raw: unknown) {}

    isObject(): boolean {
        return typeof this.raw === 'object' && this.raw !== null && !Array.isArray(this.raw);
    }

    isPresent(): boolean {
        return this.raw !== undefined && this.raw !== null;
    }

    /** The keys of this object, in document order. */
    keys(): readonly string[] {
        return this.isObject() ? Object.keys(this.raw as JsonMap) : [];
    }

    at(key: string): SpecNode {
        return this.isObject() ? new SpecNode((this.raw as JsonMap)[key]) : new SpecNode(undefined);
    }

    text(key: string): string | undefined {
        const value = this.at(key).raw;
        return typeof value === 'string' ? value : undefined;
    }

    flag(key: string): boolean | undefined {
        const value = this.at(key).raw;
        return typeof value === 'boolean' ? value : undefined;
    }

    asText(): string | undefined {
        return typeof this.raw === 'string' ? this.raw : undefined;
    }

    list(key: string): readonly SpecNode[] {
        return this.at(key).asList();
    }

    asList(): readonly SpecNode[] {
        return Array.isArray(this.raw) ? (this.raw as JsonValue[]).map((entry: JsonValue) => new SpecNode(entry)) : [];
    }

    /** The strings of the array at `key` (non-strings dropped). */
    texts(key: string): readonly string[] {
        return this.list(key)
            .map((entry: SpecNode) => entry.asText())
            .filter((entry: string | undefined): entry is string => entry !== undefined);
    }
}
