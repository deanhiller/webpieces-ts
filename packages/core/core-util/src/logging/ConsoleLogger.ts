import { Logger } from './Logger';

/**
 * ConsoleLogger - the default, browser-safe {@link Logger} implementation.
 *
 * Backed purely by `console.*` (no Node imports), so it works unchanged in the
 * browser (Angular/React) and in Node. Each line is prefixed with the logger
 * name so multi-source logs stay greppable. An optional `Error` is forwarded to
 * `console.*` as a second argument so its stack trace is rendered.
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

    private prefix(): string {
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
