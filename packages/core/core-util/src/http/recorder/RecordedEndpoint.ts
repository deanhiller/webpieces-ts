/**
 * RecordedError - Serializable capture of a thrown error.
 * Per CLAUDE.md: data-only structure = class.
 */
export class RecordedError {
    constructor(
        public readonly name: string,
        public readonly message: string,
    ) {}
}

/**
 * RecordedEndpoint - One captured API invocation (port of Java EndpointInfo).
 *
 * Captures the server endpoint that was hit OR a downstream call made while
 * serving it (outbound HTTP client call or in-process recordable() api).
 */
export class RecordedEndpoint {
    /** Response returned on success (JSON-serializable DTO). */
    // webpieces-disable no-any-unknown -- recorded DTOs are api-specific, erased here
    public successResponse?: unknown;

    /** Error thrown on failure. */
    public failureResponse?: RecordedError;

    constructor(
        /** Api class name, e.g. 'SaveApi' or 'RemoteApi'. */
        public readonly apiName: string,
        /** Method invoked, e.g. 'save'. */
        public readonly methodName: string,
        /** Arguments passed (the request DTO(s)). */
        // webpieces-disable no-any-unknown -- recorded DTOs are api-specific, erased here
        public readonly args: unknown[],
        /** Masked snapshot of the magic context headers at call time. */
        public readonly ctxSnapshot?: Record<string, string>,
    ) {}
}

/**
 * RecordedTestCase - The full capture for one inbound request: the server
 * endpoint plus every downstream call it triggered (which become the mocks
 * in the generated test).
 */
export class RecordedTestCase {
    constructor(
        public readonly serverEndpoint: RecordedEndpoint,
        public readonly downstreamCalls: RecordedEndpoint[],
        public readonly recordedAt: string,
    ) {}
}
