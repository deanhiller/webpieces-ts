/**
 * Config / stdin / plumbing failures whose message is written for the AI reading the deny.
 *
 * ## `instanceof` must work across package COPIES (#1273)
 *
 * An installed release gives every `@webpieces/*` package its OWN nested copy of
 * `@webpieces/tooling-common` (measured: `node_modules/@webpieces/<pkg>/node_modules/@webpieces/tooling-common`
 * is a real directory per package). So an `InformAiError` thrown by `@webpieces/rules-config` was NOT an
 * `instanceof` the `InformAiError` the hook adapter imported, the adapter's "structured config error"
 * branch never matched, and a plain config problem was rendered as `hook crashed unexpectedly — failing
 * closed` on every tool call, reads included. The brand below makes the check a property of the value,
 * not of which copy of this file constructed it.
 */
export class InformAiError extends Error {
    override cause?: Error;
    /** The cross-copy brand `Symbol.hasInstance` reads. Never set by hand. */
    readonly webpiecesInformAiError = true;

    constructor(message: string, options?: { cause?: Error }) {
        super(message);
        this.name = 'InformAiError';
        this.cause = options?.cause;
    }

    // The language calls Symbol.hasInstance on the CONSTRUCTOR, so this one hook cannot be an instance method.
    // webpieces-disable no-any-unknown -- `instanceof` receives any value by definition; the brand narrows it
    static override [Symbol.hasInstance](value: unknown): boolean { // webpieces-disable no-function-outside-class -- `instanceof` dispatches to the constructor
        // A SUBCLASS keeps ordinary prototype semantics: only `x instanceof InformAiError` itself is branded.
        if (this !== InformAiError) return Function.prototype[Symbol.hasInstance].call(this, value);
        return value instanceof Error && (value as InformAiError).webpiecesInformAiError === true;
    }
}
