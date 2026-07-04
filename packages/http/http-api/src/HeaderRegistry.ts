import { PlatformHeader } from './PlatformHeader';
import { PlatformHeadersExtension } from './PlatformHeadersExtension';

/**
 * HeaderRegistry - The single source of truth for all PlatformHeaders known to
 * the platform. Port of Java webpieces' HeaderTranslation.
 *
 * Every consumer (server filters, logging, metrics, outbound HTTP clients)
 * reads the header set from this registry, so externally-defined headers are
 * honored everywhere ("infinitely scalable magic context").
 *
 * Constructible in BOTH environments:
 * - Server (Inversify): WebpiecesModule binds it via
 *   `toDynamicValue(ctx => new HeaderRegistry(ctx.getAll(HEADER_TYPES.PlatformHeadersExtension)))`
 *   so every module's PlatformHeadersExtension is collected automatically.
 * - Browser (no DI): `new HeaderRegistry([new PlatformHeadersExtension([...])])`.
 *
 * Duplicate validation (port of Java checkForDuplicates) runs at construction,
 * so conflicting definitions fail fast at startup:
 * - Two headers with the same headerName must agree on ALL flags and loggerMdcKey.
 * - Two headers with the same loggerMdcKey must agree on headerName (and therefore flags).
 * - Exact duplicates (same name, same flags) collapse to one entry.
 */
export class HeaderRegistry {
    private readonly headers: PlatformHeader[];

    constructor(extensions: PlatformHeadersExtension[]) {
        const allHeaders: PlatformHeader[] = [];
        for (const extension of extensions) {
            allHeaders.push(...extension.getHeaders());
        }
        this.headers = this.checkForDuplicates(allHeaders);
    }

    /**
     * All registered headers (deduplicated).
     */
    getHeaders(): PlatformHeader[] {
        return this.headers;
    }

    /**
     * Headers that transfer over the wire (inbound request -> context, and
     * context -> outbound request). isWantTransferred=true.
     */
    getTransferredHeaders(): PlatformHeader[] {
        return this.headers.filter((h: PlatformHeader) => h.isWantTransferred);
    }

    /**
     * Header names whose values must be masked in logs. isSecured=true.
     */
    getSecuredNames(): string[] {
        return this.headers
            .filter((h: PlatformHeader) => h.isSecured)
            .map((h: PlatformHeader) => h.headerName);
    }

    /**
     * Headers exposed as MDC/structured-log dimensions (loggerMdcKey set).
     */
    getMdcHeaders(): PlatformHeader[] {
        return this.headers.filter((h: PlatformHeader) => h.loggerMdcKey !== undefined);
    }

    /**
     * Look up a header definition by its HTTP name (case-insensitive).
     */
    findByName(headerName: string): PlatformHeader | undefined {
        const lower = headerName.toLowerCase();
        return this.headers.find((h: PlatformHeader) => h.headerName.toLowerCase() === lower);
    }

    /**
     * Port of Java HeaderTranslation.checkForDuplicates: collapse exact
     * duplicates, throw on conflicting definitions sharing a name or MDC key.
     */
    private checkForDuplicates(allHeaders: PlatformHeader[]): PlatformHeader[] {
        const byName = new Map<string, PlatformHeader>();
        const byMdcKey = new Map<string, PlatformHeader>();

        for (const header of allHeaders) {
            const nameKey = header.headerName.toLowerCase();
            const existing = byName.get(nameKey);
            if (existing) {
                this.assertSameDefinition(existing, header);
                continue; // exact duplicate - collapse
            }
            byName.set(nameKey, header);

            if (header.loggerMdcKey !== undefined) {
                const mdcClash = byMdcKey.get(header.loggerMdcKey);
                if (mdcClash) {
                    throw new Error(
                        `Duplicate PlatformHeader loggerMdcKey '${header.loggerMdcKey}': ` +
                        `defined by header '${mdcClash.headerName}' AND header '${header.headerName}'. ` +
                        `Each MDC key must map to exactly one header.`,
                    );
                }
                byMdcKey.set(header.loggerMdcKey, header);
            }
        }

        return Array.from(byName.values());
    }

    /**
     * Two headers sharing a headerName must agree on every flag and the MDC key,
     * otherwise the platform would behave differently depending on which module's
     * definition happened to load first.
     */
    private assertSameDefinition(existing: PlatformHeader, duplicate: PlatformHeader): void {
        const conflicts: string[] = [];
        if (existing.isWantTransferred !== duplicate.isWantTransferred) {
            conflicts.push(`isWantTransferred (${existing.isWantTransferred} vs ${duplicate.isWantTransferred})`);
        }
        if (existing.isSecured !== duplicate.isSecured) {
            conflicts.push(`isSecured (${existing.isSecured} vs ${duplicate.isSecured})`);
        }
        if (existing.isDimensionForMetrics !== duplicate.isDimensionForMetrics) {
            conflicts.push(`isDimensionForMetrics (${existing.isDimensionForMetrics} vs ${duplicate.isDimensionForMetrics})`);
        }
        if (existing.loggerMdcKey !== duplicate.loggerMdcKey) {
            conflicts.push(`loggerMdcKey ('${existing.loggerMdcKey}' vs '${duplicate.loggerMdcKey}')`);
        }
        if (conflicts.length > 0) {
            throw new Error(
                `Conflicting PlatformHeader definitions for '${existing.headerName}': ` +
                `two modules registered it with different ${conflicts.join(', ')}. ` +
                `Headers sharing a name must agree on all flags.`,
            );
        }
    }
}
