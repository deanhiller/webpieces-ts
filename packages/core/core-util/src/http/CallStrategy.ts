/** One bounded attempt. Only an explicitly registered strategy may retry it. */
export type Attempt<T> = (timeoutMs: number) => Promise<T>;

/** Contract identity for diagnostics; registry keys use the class itself. */
export class CallContext {
    constructor(
        public readonly apiName: string,
        public readonly methodName: string,
    ) {}
}

/** Owns all timing and retry decisions. No public cancellation signal. */
export type CallStrategy<T> = (call: Attempt<T>, ctx: CallContext) => Promise<T>;
