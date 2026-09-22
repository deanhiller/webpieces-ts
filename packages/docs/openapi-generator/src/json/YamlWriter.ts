import { JsonObject, JsonValue } from './JsonObject';

/**
 * The SAME in-memory {@link JsonObject} -> block YAML. One generation pass, two serializations, so
 * the JSON and the YAML document cannot disagree about anything.
 *
 * ## Why this package emits YAML itself rather than depending on a YAML library
 *
 * The value space here is exactly JSON's — string, number, boolean, null, array, object — because
 * that is all an OpenAPI document holds and all a {@link JsonObject} can carry. There are no dates,
 * no anchors, no tags, no multi-document streams and no cyclic references, which is the entire
 * reason a general YAML serializer is a large dependency. Emitting the subset directly keeps the
 * package's dependencies at `typescript` and `@webpieces/api-doc-model`, which is what lets it be
 * pointed at any upstream project without dragging a tree behind it.
 *
 * ## Every string is DOUBLE-QUOTED, deliberately
 *
 * YAML's plain (unquoted) scalars are where its sharp edges live: `no` is a boolean, `1.0` is a
 * number, `*ref` is an alias, a leading `%` or `@` is reserved, and a colon-space inside the text
 * ends the key. A generator that quoted "only when necessary" would need to model every one of those
 * rules correctly, forever, and would fail silently — a partner reading `version: 1.0` as a float is
 * not a crash, it is a wrong document. Double-quoted YAML uses JSON's own escape grammar, so
 * `JSON.stringify` of a string is a valid YAML scalar by construction. The output is a little
 * noisier and cannot be wrong.
 */
export class YamlWriter {
    write(root: JsonObject): string {
        if (root.isEmpty()) {
            return '{}\n';
        }
        return this.objectLines(root, '').join('\n') + '\n';
    }

    /** The lines of one object, each already prefixed with `indent`. */
    private objectLines(object: JsonObject, indent: string): string[] {
        const lines: string[] = [];
        for (const key of object.keys()) {
            this.appendEntry(lines, `${indent}${this.key(key)}:`, object.get(key)!, indent);
        }
        return lines;
    }

    /** One `key:` (or one `-`) followed by its value, inline when scalar and nested when not. */
    private appendEntry(lines: string[], prefix: string, value: JsonValue, indent: string): void {
        if (value instanceof JsonObject) {
            if (value.isEmpty()) {
                lines.push(`${prefix} {}`);
                return;
            }
            lines.push(prefix);
            lines.push(...this.objectLines(value, `${indent}    `));
            return;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                lines.push(`${prefix} []`);
                return;
            }
            lines.push(prefix);
            lines.push(...this.arrayLines(value, `${indent}    `));
            return;
        }
        lines.push(`${prefix} ${this.scalar(value)}`);
    }

    private arrayLines(items: readonly JsonValue[], indent: string): string[] {
        const lines: string[] = [];
        for (const item of items) {
            if (item instanceof JsonObject && !item.isEmpty()) {
                // A `- ` opens the item and its FIRST key shares that line; the rest align under it.
                const nested = this.objectLines(item, `${indent}  `);
                lines.push(`${indent}- ${nested[0]!.trimStart()}`);
                lines.push(...nested.slice(1));
                continue;
            }
            this.appendEntry(lines, `${indent}-`, item, indent);
        }
        return lines;
    }

    /** A key is a string, so it gets the same unconditional quoting the class doc argues for. */
    private key(key: string): string {
        return JSON.stringify(key);
    }

    private scalar(value: JsonValue): string {
        return value === null ? 'null' : JSON.stringify(value);
    }
}
