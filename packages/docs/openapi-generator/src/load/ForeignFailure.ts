import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * A failure thrown by `@webpieces/api-doc-model`, carried across into THIS package's one error type.
 *
 * ## Why it is translated rather than allowed through
 *
 * `wp-openapi`'s top-level handler renders exactly one error type. Letting `ApiDocExtractionError`
 * out as well would give it two to know about, only one of which is on this package's surface — and
 * the second would be rendered by whichever branch somebody remembered to write.
 *
 * The extractor's own `location` and `cure` are the good part of its failure: they name the line of
 * the contract and what to write there. Translating means keeping both, so the handler prints the
 * extractor's cure verbatim instead of a vaguer one of this package's own.
 */
export class ForeignFailure {
    private constructor(
        readonly message: string,
        readonly location: string | undefined,
        readonly cure: string | undefined,
    ) {}

    /** Read whatever the thrown value actually carries, without assuming it carries anything. */
    // webpieces-disable no-any-unknown -- a caught value is genuinely of unknown type; narrowing it is this method's whole job
    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops a half-read failure being built
    static of(err: unknown): ForeignFailure {
        const message = err instanceof Error ? err.message : String(err);
        const carried = err instanceof Error ? (err as Partial<ForeignFailure>) : undefined;
        return new ForeignFailure(
            message,
            typeof carried?.location === 'string' ? carried.location : undefined,
            typeof carried?.cure === 'string' ? carried.cure : undefined,
        );
    }

    /** The same failure as this package's one error type, falling back where the thrower said less. */
    asGenerationError(fallbackLocation: string, fallbackCure: string): OpenApiGenerationError {
        return new OpenApiGenerationError(
            this.message,
            this.location ?? fallbackLocation,
            this.cure ?? fallbackCure,
        );
    }
}
