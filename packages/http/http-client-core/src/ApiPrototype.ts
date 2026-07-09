/**
 * Type representing a class constructor whose prototype is T — the shared API contract class,
 * carrying the @ApiPath/@Endpoint/@Auth* decorators that both the client and the server read.
 */
export type ApiPrototype<T> = Function & { prototype: T };
