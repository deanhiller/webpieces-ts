/**
 * The ONE failure type this package throws. A run either renders a complete site or throws this — it
 * never prints a warning, never writes a half-site, and never guesses at a document it cannot read.
 *
 * It is a structured throw to the single top-level handler in `WpDocsSiteMain`, per
 * `.claude/review/error-output.md`: `location` and `cure` are carried as FIELDS rather than baked
 * into `message`, so the CLI renders them per audience and this class hand-numbers nothing.
 *
 * It is NOT `RuleFailError`, and for the same reason `@webpieces/openapi-generator` gave: that type
 * lives in `@webpieces/rules-config`, the TOOLING stream a repo pins one release behind on purpose,
 * while `packages/docs/*` publish with the SERVER libs. It is also not `OpenApiGenerationError` —
 * this package renders ANY conforming document and therefore depends on the generator not at all.
 */
export class DocsSiteError extends Error {
    constructor(
        message: string,
        /** Where the problem IS — a spec path, a prose directory, or `<spec>#/paths/~1orders`. */
        readonly location: string,
        /** What to do instead, in one sentence. No numbering — the CLI owns that. */
        readonly cure: string,
    ) {
        super(`${message} (${location})`);
        this.name = 'DocsSiteError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
