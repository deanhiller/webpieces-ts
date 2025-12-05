import { Header } from '@webpieces/core-util';

/**
 * PlatformHeader - Defines an HTTP header that can be transferred between services.
 *
 * Simplified from Java PlatformHeaders:
 * - Single headerName field (used for both HTTP header and MDC logging key)
 * - No separate getLoggerMDCKey() - just use headerName
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

    constructor(
        headerName: string,
        isWantTransferred: boolean = true,
        isSecured: boolean = false,
        isDimensionForMetrics: boolean = false
    ) {
        this.headerName = headerName;
        this.isWantTransferred = isWantTransferred;
        this.isSecured = isSecured;
        this.isDimensionForMetrics = isDimensionForMetrics;
    }

    /**
     * Get the header name (implements Header interface).
     * @returns The HTTP header name
     */
    getHeaderName(): string {
        return this.headerName;
    }
}
