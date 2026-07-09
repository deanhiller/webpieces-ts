/**
 * BunyanFactoryOptions - tuning for the bunyan LoggerFactory backends.
 *
 * Data-only structure → a class, per CLAUDE.md.
 *
 * There is deliberately NO level knob: webpieces does not filter by level — that
 * is bunyan's job (bunyan filters at its own default). You must name the service.
 */
export class BunyanFactoryOptions {
    constructor(
        /**
         * The bunyan logger `name` (surfaces as `name` in Cloud Logging's JSON
         * payload). REQUIRED — every service names itself.
         */
        public readonly serviceName: string,
    ) {}
}
