import { EndpointOperation } from './HttpEndpointOptions';

/** One bounded attempt. Only an explicitly registered strategy may retry it. */
export type Attempt<T> = (timeoutMs: number) => Promise<T>;

/**
 * Contract identity for diagnostics; registry keys use the class itself.
 *
 * `operation` is the endpoint's declared `@Endpoint` side-effect contract (`READ`,
 * `WRITE_IDEMPOTENT` or `WRITE`). A {@link CallStrategy} reads it to decide whether a retry is safe,
 * and `ApiCallTimeoutError` reads it to choose the text it shows an end user. A transport with
 * no declared operation (IPC contracts declare none) passes `WRITE`: the conservative answer, since
 * it never invites a blind retry of something that may already have happened.
 */
export class CallContext {
    /**
     * The contract CLASS the call belongs to — the key of the `CallScope` ladder, so a strategy's
     * per-attempt error classification resolves the classifier registered for THIS contract.
     * `CallRegistry.execute` guarantees it on the context a strategy sees; undefined only for a
     * transport with no contract class (an IPC deadline), which reaches the ALL rung alone.
     *
     * NON-enumerable on purpose: this context rides on `ApiCallTimeoutError`, which is logged and
     * compared as data, and a class reference is not data.
     */
    declare readonly contract: Function | undefined;

    constructor(
        public readonly apiName: string,
        public readonly methodName: string,
        public readonly operation: EndpointOperation,
        /** REQUIRED — the contract CLASS, or explicit `undefined`; see {@link CallContext.contract}. */
        contract: Function | undefined,
    ) {
        Object.defineProperty(this, 'contract', { value: contract, enumerable: false });
    }
}

/** Owns all timing and retry decisions. No public cancellation signal. */
export type CallStrategy<T> = (call: Attempt<T>, ctx: CallContext) => Promise<T>;
