/**
 * Explicit, recursive JSON DATA in an API: a string, a number, a boolean, `null`, an array of
 * JSON values, or an object whose every value is a JSON value (#1447).
 *
 * Like {@link Integer}, this alias is a DECLARATION for the document generator rather than a runtime
 * type. `@webpieces/api-doc-model` reads the written syntax, recognises a reference to a TYPE ALIAS
 * named `JsonValueDto` and publishes it as the open JSON schema
 * `{ "type": ["string","number","boolean","object","array","null"], "additionalProperties": true }`
 * — in every OpenAPI document and every MCP tool catalog — instead of trying to expand a
 * self-referencing union, which no schema walk can do.
 *
 * Use it ONLY where a payload is genuinely free-form JSON whose shape a server-owned runtime
 * definition validates (an extensible settings bag, a tool's opaque arguments). Every ordinary DTO
 * stays a closed, named type: an undeclared key on one is still refused at the boundary, and only
 * an object reached through this marker accepts any key.
 *
 * The marker is the alias NAME, exactly like `Integer`, because a type alias has no runtime identity
 * a decorator could carry. A consumer may therefore import this one or declare its own alias of the
 * same name; a CLASS or INTERFACE named `JsonValueDto` is NOT the marker and is documented as the
 * ordinary DTO it is.
 */
export type JsonValueDto =
    | string
    | number
    | boolean
    | null
    | JsonValueDto[]
    | { [key: string]: JsonValueDto };
