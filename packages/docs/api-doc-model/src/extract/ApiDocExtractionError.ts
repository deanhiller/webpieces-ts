/**
 * The ONE failure type this package throws. Extraction either produces a complete
 * {@link ApiDocModel} or throws this — it never prints, never warns, and never guesses.
 *
 * It is a structured throw to the caller's single top-level handler, per
 * `.claude/review/error-output.md`: `location` and `cure` are carried as FIELDS rather than baked
 * into `message`, so a renderer (#982) can print them per audience, and it hand-numbers nothing.
 *
 * It is NOT `RuleFailError`. That type lives in `@webpieces/rules-config`, and this package depends
 * on `typescript` and nothing else so it can be pointed at any upstream project's contract — see
 * `responsibilities.md`. A dependency added here to reuse an error class would end that guarantee
 * for every consumer, which is a far larger cost than one more error type.
 *
 * WHY a throw and not a recorded warning: the two cases that reach it are a path that cannot be
 * constant-folded and a numeric constraint on a non-numeric field. Both mean the DOCUMENT would be
 * wrong — a guessed path, or a range on a string — and a partner-grade document that is quietly
 * wrong is worse than one that failed to build. Something the extractor merely cannot REPRESENT is a
 * different thing and is recorded as an {@link UnmappedType} instead.
 */
export class ApiDocExtractionError extends Error {
    constructor(
        message: string,
        /** Pointer-style `path/to/File.ts:12:5`, so an agent can open the exact line. */
        readonly location: string,
        /** What to do instead, in one sentence. No numbering — the caller's renderer owns that. */
        readonly cure: string,
    ) {
        super(`${message} (${location})`);
        this.name = 'ApiDocExtractionError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
