import { ContextKey } from '../ContextKey';
import { PlatformHeader } from './PlatformHeader';

/**
 * ContextReader - Interface for reading header values from context.
 *
 * Different implementations for different environments:
 * - RequestContextReader: Node.js with AsyncLocalStorage (in @webpieces/http-routing, server-side only)
 * - MutableContextStore / StaticContextReader: Browser or testing with manual header
 *   management (in @webpieces/http-client)
 * - CompositeContextReader: Combines multiple readers with priority (in @webpieces/http-client)
 *
 * This interface is defined in @webpieces/http-api so both http-routing and http-client
 * can use it without creating circular dependencies. It is DI-independent so it works in
 * both server (Inversify) and client (Angular/React, browser) environments.
 *
 * This is a business-logic interface (per CLAUDE.md: behavior = interface).
 */
export interface ContextReader {
    /**
     * Read the value of a platform header.
     * Returns undefined if header not available.
     *
     * @param header - The platform header to read
     * @returns The header value, or undefined if not present
     */
    read(header: PlatformHeader): string | undefined;

    /**
     * OPTIONAL: read a non-header context value (e.g. the active
     * TestCaseRecorder under RecorderKeys.RECORDER).
     *
     * Server-side readers (RequestContextReader) implement this over the
     * RequestContext; browser readers may omit it (no server-side recording
     * in browsers - same as Java). This keeps http-client free of any
     * Node-only imports while still letting it find the recorder.
     */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (recorder, meta objects)
    readValue?(key: ContextKey): unknown;
}
