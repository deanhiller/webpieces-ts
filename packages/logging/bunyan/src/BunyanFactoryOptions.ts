import type { LogLevel } from '@webpieces/core-util';

/**
 * BunyanFactoryOptions - tuning for the bunyan LoggerFactory backends.
 *
 * Data-only structure → a class, per CLAUDE.md. All fields optional; a bare
 * `new BunyanGcpFactory(reader)` uses the defaults.
 */
export class BunyanFactoryOptions {
    constructor(
        /** Minimum webpieces level to emit. Defaults to 'info'. */
        public readonly level: LogLevel = 'info',
        /**
         * The bunyan logger `name` (surfaces as `name` in Cloud Logging's JSON
         * payload). Defaults to 'webpieces'.
         */
        public readonly serviceName: string = 'webpieces',
    ) {}
}
