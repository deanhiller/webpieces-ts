/**
 * WinstonFactoryOptions - tuning for the winston LoggerFactory backends.
 *
 * Data-only structure → a class, per CLAUDE.md.
 *
 * There is deliberately NO level knob: webpieces does not filter by level — that
 * is winston's job (it filters at its own default). `svcGitHash` is optional, so a
 * bare `new WinstonGcpFactory()` still works.
 */
export class WinstonFactoryOptions {
    constructor(
        /**
         * The running service's git commit SHA. When set, every line carries
         * `jsonPayload.svcGitHash=<sha>` (winston defaultMeta) so operators can
         * filter Cloud Logging by deployment.
         */
        public readonly svcGitHash?: string,
    ) {}
}
