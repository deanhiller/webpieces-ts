import { JsonObject, JsonValue } from './JsonObject';

/**
 * {@link JsonObject} -> pretty JSON text, 4-space indented, with a trailing newline.
 *
 * `JSON.stringify` cannot be used directly because a {@link JsonObject} is a class holding a `Map`,
 * not a plain object — and converting to plain objects first would throw away the insertion order
 * that makes a committed golden document stable (see {@link JsonObject}).
 *
 * 4 spaces and a trailing newline because that is what this repo's prettier writes for every other
 * committed JSON file; a golden that disagreed with the formatter would be reformatted on the next
 * commit and diff against itself.
 */
export class JsonWriter {
    write(root: JsonObject): string {
        return `${this.value(root, '')}\n`;
    }

    private value(value: JsonValue, indent: string): string {
        if (value instanceof JsonObject) {
            return this.object(value, indent);
        }
        if (Array.isArray(value)) {
            return this.array(value, indent);
        }
        return JSON.stringify(value);
    }

    private object(object: JsonObject, indent: string): string {
        const keys = object.keys();
        if (keys.length === 0) {
            return '{}';
        }
        const inner = `${indent}    `;
        const lines = keys.map(
            (key: string) =>
                `${inner}${JSON.stringify(key)}: ${this.value(object.get(key)!, inner)}`,
        );
        return `{\n${lines.join(',\n')}\n${indent}}`;
    }

    private array(items: readonly JsonValue[], indent: string): string {
        if (items.length === 0) {
            return '[]';
        }
        const inner = `${indent}    `;
        const lines = items.map((item: JsonValue) => `${inner}${this.value(item, inner)}`);
        return `[\n${lines.join(',\n')}\n${indent}]`;
    }
}
