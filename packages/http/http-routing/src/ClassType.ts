/** Abstract or concrete API/controller constructor identity. */
// webpieces-disable no-any-unknown -- API constructor identity is generic across unrelated contracts
export type ClassType<T = unknown> = Function & { prototype: T };
