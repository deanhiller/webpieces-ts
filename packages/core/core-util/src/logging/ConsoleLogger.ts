import { Logger } from './Logger';

/**
 * Latch so the "you never called setFactory" complaint is emitted exactly ONCE per process,
 * no matter how many bootstrap loggers or lines there are. Mirrors RequestContext's
 * reportedMissingContext latch.
 */
let reportedMissingFactory = false;

/**
 * ConsoleLogger - the default, browser-safe {@link Logger} implementation.
 *
 * Backed purely by `console.*` (no Node imports), so it works unchanged in the
 * browser (Angular/React) and in Node. Each line is prefixed with the logger
 * name so multi-source logs stay greppable. An optional `Error` is forwarded to
 * `console.*` as a second argument so its stack trace is rendered.
 *
 * It carries NO context fields (requestId, tenantId, …) — deliberately. A real logging backend
 * (bunyan/winston) reads them off the RequestContext on every record; the bootstrap console
 * cannot, because core-util is browser-safe and has no AsyncLocalStorage.
 *
 * Level → console method mapping:
 * - trace/debug → console.debug
 * - info        → console.log   (stdout, matching conventional server logging)
 * - warn        → console.warn
 * - error       → console.error
 */
export class ConsoleLogger implements Logger {
    private readonly name: string;
    private readonly bootstrapPrefix: string;

    /**
     * @param name logger name (slf4j-style; usually the class/module)
     * @param bootstrapPrefix prepended to every line while no real backend has
     *   been installed (see {@link ConsoleLoggerFactory}); empty once one is.
     */
    constructor(name: string, bootstrapPrefix = '') {
        this.name = name;
        this.bootstrapPrefix = bootstrapPrefix;
    }

    /**
     * Complain ONCE, at error level, that no logging backend was installed — a banner on every
     * line is easy to scroll past, and an app running on the bootstrap console silently loses
     * structured context fields and its GCP log payload. Every subsequent line keeps the banner.
     */
    private reportMissingFactoryOnce(): void {
        if (!this.bootstrapPrefix || reportedMissingFactory) {
            return;
        }
        reportedMissingFactory = true; // set BEFORE logging: console.error must not re-enter
        console.error(
            'No logging backend installed. Call LogManager.setFactory(...) at startup — ' +
            'see .webpieces/instruct-ai/webpieces.logging.md. Until then every line goes to the ' +
            'bootstrap console with NO context fields (requestId, tenantId, …) and no structured payload.',
        );
    }

    private prefix(): string {
        this.reportMissingFactoryOnce();
        return `${this.bootstrapPrefix}[${this.name}]`;
    }

    private errArg(err?: Error): Error[] {
        return err ? [err] : [];
    }

    trace(message: string, err?: Error): void {
        console.debug(`${this.prefix()} ${message}`, ...this.errArg(err));
    }

    debug(message: string, err?: Error): void {
        console.debug(`${this.prefix()} ${message}`, ...this.errArg(err));
    }

    info(message: string, err?: Error): void {
        console.log(`${this.prefix()} ${message}`, ...this.errArg(err));
    }

    warn(message: string, err?: Error): void {
        console.warn(`${this.prefix()} ${message}`, ...this.errArg(err));
    }

    error(message: string, err?: Error): void {
        console.error(`${this.prefix()} ${message}`, ...this.errArg(err));
    }
}
