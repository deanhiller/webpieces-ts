/**
 * An ORDERED JSON object, built by explicit `set` calls.
 *
 * ## Why a class and not an object literal
 *
 * An OpenAPI document is a JSON tree, and the obvious way to build one is a nest of object literals.
 * `CLAUDE.md` §3 forbids that, and the rule earns its keep here rather than merely applying: this
 * generator's contract with the repo is a COMMITTED GOLDEN document that a spec regenerates and
 * diffs. A literal's key order is whatever the code happened to type, spread over a dozen branches
 * that each add a key conditionally — so "the same document" would render differently depending on
 * which branch ran, and the golden would go red on a change that moved nothing a reader can see.
 *
 * `set` appends in call order and a `Map` preserves it, so the document's byte layout is a property
 * of the RENDERER, stated in one place, rather than an emergent one.
 *
 * ## `undefined` is "omit", not "null"
 *
 * Nearly every field of an OpenAPI object is optional, and the difference between an absent key and a
 * `null` one is the difference between "not stated" and "stated to be nothing". `set(key, undefined)`
 * therefore writes NOTHING, which lets a caller pass an optional straight through without an `if`
 * around every line — and `null` stays available for the places 3.1 genuinely means it.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export class JsonObject {
    private readonly entries = new Map<string, JsonValue>();

    /** Append one key. `undefined` writes nothing — see the class doc. */
    set(key: string, value: JsonValue | undefined): this {
        if (value !== undefined) {
            this.entries.set(key, value);
        }
        return this;
    }

    get(key: string): JsonValue | undefined {
        return this.entries.get(key);
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    isEmpty(): boolean {
        return this.entries.size === 0;
    }

    /** The keys in INSERTION order — the order both writers emit them in. */
    keys(): readonly string[] {
        return Array.from(this.entries.keys());
    }

    /** This object, or `undefined` when nothing was ever set on it. For an optional section. */
    orUndefined(): JsonObject | undefined {
        return this.isEmpty() ? undefined : this;
    }
}
