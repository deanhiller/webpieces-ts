/**
 * The ONE failure type this package throws. Generation either produces a complete pair of documents
 * or throws this — it never prints a warning, never writes a partial file, and never guesses.
 *
 * It is a structured throw to the single top-level handler in `wp-openapi`, per
 * `.claude/review/error-output.md`: `location` and `cure` are carried as FIELDS rather than baked
 * into `message`, and `pointers` carries the JSON pointers of an unmapped-type refusal, so the CLI
 * renders them per audience and this class hand-numbers nothing.
 *
 * It is NOT `RuleFailError`. That type lives in `@webpieces/rules-config` — the TOOLING stream, which
 * a repo pins one release behind on purpose — and this package publishes with the SERVER libs so an
 * app's `@webpieces/core-util` pin pins a generator that understands that app's decorators (see
 * `responsibilities.md`). Depending across the two streams to reuse an error class would couple the
 * generator's release to the rule engine's, which is the coupling the epic exists to avoid. This is
 * the same call `@webpieces/api-doc-model` made, and for a reason of the same size.
 */
export class OpenApiGenerationError extends Error {
    constructor(
        message: string,
        /** Where the problem IS — a manifest path, a contract file, or `<manifest>#/apis/0`. */
        readonly location: string,
        /** What to do instead, in one sentence. No numbering — the CLI owns that. */
        readonly cure: string,
        /**
         * JSON pointers into the document that WOULD have been written, one per offending field.
         * Empty for every failure that is not the unmapped-type refusal. It is a separate field
         * rather than a list glued into `message` because the list is the actionable part: an agent
         * fixes the contract one pointer at a time.
         */
        readonly pointers: readonly string[] = [],
    ) {
        super(`${message} (${location})`);
        this.name = 'OpenApiGenerationError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
