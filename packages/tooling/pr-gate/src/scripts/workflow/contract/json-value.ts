/** Everything a JSON document can hold — a parsed OpenAPI document or package.json is exactly this. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** The object case of {@link JsonValue}, named so the recursive alias can refer to it. */
export type JsonObject = { [key: string]: JsonValue };
