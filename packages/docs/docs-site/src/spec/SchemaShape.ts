import { JsonNode } from './JsonNode';

/**
 * What a schema node says about ITSELF, with no catalog of named schemas needed to answer.
 *
 * It is separate from `SchemaLens` because `SpecReader` has to answer "does this named schema
 * deserve a page" while it is still BUILDING the list of named schemas — there is no `ApiSpec` to
 * hand a lens yet. Folding these three questions into the lens would mean constructing a lens over a
 * half-built spec, which is the kind of ordering dependency that works until somebody reorders two
 * lines.
 */
export class SchemaShape {
    /** True when a NAMED schema deserves its own page: objects and object unions, never scalars. */
    hasOwnPage(node: JsonNode): boolean {
        if (node.at('properties').isObject()) {
            return true;
        }
        if (node.at('oneOf').asList().length > 0 || node.at('allOf').asList().length > 0) {
            return true;
        }
        return this.declaredType(node) === 'object';
    }

    /**
     * The declared `type`, with 3.1's `type: [T, "null"]` reduced to `T`. A nullable field's type
     * column shows the NON-null type: "it is a string, and it may be absent" is one fact about the
     * field, not two types.
     */
    declaredType(node: JsonNode): string | undefined {
        const direct = node.text('type');
        if (direct !== undefined) {
            return direct;
        }
        for (const entry of node.list('type')) {
            const name = entry.asText();
            if (name !== undefined && name !== 'null') {
                return name;
            }
        }
        return undefined;
    }

    /** True when the node states, in either dialect, that null is allowed. */
    isNullable(node: JsonNode): boolean {
        if (node.flag('nullable') === true) {
            return true;
        }
        for (const entry of node.list('type')) {
            if (entry.asText() === 'null') {
                return true;
            }
        }
        for (const branch of node.list('anyOf')) {
            if (branch.text('type') === 'null') {
                return true;
            }
        }
        return false;
    }
}
