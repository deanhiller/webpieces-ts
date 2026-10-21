/**
 * Every refusal `wp-openapi-import` makes: a bad import file, a spec it cannot read, an operation it
 * cannot express. THROWN, never printed — `WpOpenApiImportMain` is the one top-level handler and
 * renders it from these fields (`.claude/review/error-output.md`).
 */
export class OpenApiImportError extends Error {
    constructor(
        message: string,
        /** Where the problem IS — the import file, a spec pointer, `<operationId>`. */
        readonly location: string,
        /** What to do instead, in one sentence. */
        readonly cure: string,
        /** The underlying failure, when one was caught (a JSON parse error), carried whole. */
        cause?: Error,
    ) {
        super(`${message} (${location})`, cause === undefined ? undefined : { cause });
        this.name = 'OpenApiImportError';
    }
}
