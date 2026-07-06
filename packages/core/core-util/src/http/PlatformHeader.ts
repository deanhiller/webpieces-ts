import { Header } from '../Header';

/**
 * PlatformHeader - Defines an HTTP header that can be transferred between services.
 *
 * Port of Java PlatformHeaders, simplified:
 * - No isWantLogged flag (deprecated in Java) - "wants MDC logging" is expressed
 *   by setting loggerMdcKey. Headers without one still appear in API logs
 *   (masked when isSecured); they just aren't exposed as an MDC dimension key.
 *
 * Implements Header interface from core-util to avoid circular dependencies.
 *
 * Per CLAUDE.md: "All data-only structures MUST be classes, not interfaces."
 * This is a data-only class with no business logic methods.
 */
export class PlatformHeader implements Header {
    /**
     * The HTTP header name (e.g., 'x-request-id', 'x-tenant-id').
     * Also used as the MDC logging key in RequestContext.
     * Case-insensitive per HTTP spec, but stored in canonical form.
     */
    readonly headerName: string;

    /**
     * Whether this header should be transferred from HTTP request to RequestContext.
     * If false, header is defined but not automatically transferred.
     * Only headers with isWantTransferred=true are copied from incoming requests.
     */
    readonly isWantTransferred: boolean;

    /**
     * Whether this header contains sensitive data that should be secured/masked in logs.
     * Examples: Authorization tokens, passwords, API keys.
     */
    readonly isSecured: boolean;

    /**
     * Whether this header should be used as a dimension for metrics/monitoring.
     * Examples: x-tenant-id, x-request-id (for distributed tracing).
     */
    readonly isDimensionForMetrics: boolean;

    /**
     * Key used when exposing this header to the logger's MDC / structured log
     * dimensions. Port of Java getLoggerMDCKey(). When set, log maps key this
     * header by it instead of headerName (e.g. 'requestId' vs 'x-request-id').
     * Undefined = not an MDC dimension (Java: getLoggerMDCKey() == null).
     */
    readonly loggerMdcKey?: string;

    constructor(
        headerName: string,
        isWantTransferred: boolean = true,
        isSecured: boolean = false,
        isDimensionForMetrics: boolean = false,
        loggerMdcKey?: string
    ) {
        this.headerName = headerName;
        this.isWantTransferred = isWantTransferred;
        this.isSecured = isSecured;
        this.isDimensionForMetrics = isDimensionForMetrics;
        this.loggerMdcKey = loggerMdcKey;
    }

    /**
     * Get the header name (implements Header interface).
     * @returns The HTTP header name
     */
    getHeaderName(): string {
        return this.headerName;
    }
}
