/**
 * BootstrapOptions - the per-server inputs to {@link bootstrapServer}.
 *
 * Data-only structure (a class, not an inline object literal, per the webpieces
 * guidelines) so each server constructs it explicitly: `new BootstrapOptions(8200, 'Server')`.
 *
 * The logging backend, DI modules, and context keys now live in the per-app
 * `buildXxxApiFactory` (via CompanySetupOptions), so the same declaration serves the
 * server and its tests; bootstrapServer only needs the transport-level port + log name.
 */
export class BootstrapOptions {
    /**
     * @param port - Default listen port (overridden by the `PORT` env var if set).
     * @param logName - Logger name / tag for this service's startup lines.
     */
    constructor(
        public readonly port: number,
        public readonly logName: string,
    ) {}
}
