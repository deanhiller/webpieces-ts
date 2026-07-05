import { LoggerFactory, ConsoleLoggerFactory } from '@webpieces/wp-logging';

/**
 * BootstrapOptions - the per-server inputs to {@link bootstrapServer}.
 *
 * Data-only structure (a class, not an inline object literal, per the webpieces
 * guidelines) so each server constructs it explicitly:
 * `new BootstrapOptions(8200, 'Server')`.
 */
export class BootstrapOptions {
    /**
     * @param port - Default listen port (overridden by the `PORT` env var if set).
     * @param logName - Logger name / tag for this service's startup lines.
     * @param loggerFactory - The server-side logging backend to install. Defaults
     *   to the browser-safe console factory; this is the seam where a node-only
     *   backend (bunyan/winston/pino/file writer) is plugged in per service.
     */
    constructor(
        public readonly port: number,
        public readonly logName: string,
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
    ) {}
}
