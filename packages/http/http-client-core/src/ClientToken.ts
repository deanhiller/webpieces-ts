declare const clientTokenContract: unique symbol;

/** Opt-in invariant contract type for a local DI token; legacy symbols remain supported. */
export class ClientToken<T extends object> {
    declare readonly [clientTokenContract]: (value: T) => T;
    constructor(public readonly identifier: symbol) {}
}
