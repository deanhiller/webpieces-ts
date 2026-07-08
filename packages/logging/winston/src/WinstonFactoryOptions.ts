import type { LogLevel } from '@webpieces/core-util';

/**
 * WinstonFactoryOptions - tuning for the winston LoggerFactory backends.
 *
 * Data-only structure → a class, per CLAUDE.md. All fields optional; a bare
 * `new WinstonGcpFactory(reader)` uses the defaults (INFO threshold, no git hash).
 */
export class WinstonFactoryOptions {
    constructor(
        /**
         * Minimum webpieces level to emit. Defaults to 'info' (matching the
         * tested monorepo-nx logger); pass 'trace'/'debug' to see finer lines.
         */
        public readonly level: LogLevel = 'info',
        /**
         * The running service's git commit SHA. When set, every line carries
         * `jsonPayload.svcGitHash=<sha>` (winston defaultMeta) so operators can
         * filter Cloud Logging by deployment.
         */
        public readonly svcGitHash?: string,
    ) {}
}
