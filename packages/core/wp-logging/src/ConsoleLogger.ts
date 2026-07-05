import { Logger, LogArg } from './Logger';

/**
 * ConsoleLogger - the default, browser-safe {@link Logger} implementation.
 *
 * Backed purely by `console.*` (no Node imports), so it works unchanged in the
 * browser (Angular/React) and in Node. Each line is prefixed with the logger
 * name so multi-source logs stay greppable; callers that pass their own tag
 * (e.g. `[API-SVR-req] ...`) keep it inside the message.
 *
 * Level → console method mapping:
 * - trace/debug → console.debug
 * - info        → console.log   (stdout, matching conventional server logging)
 * - warn        → console.warn
 * - error       → console.error
 */
export class ConsoleLogger implements Logger {
    private readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    private prefix(): string {
        return `[${this.name}]`;
    }

    trace(message: string, ...args: LogArg[]): void {
        console.debug(`${this.prefix()} ${message}`, ...args);
    }

    debug(message: string, ...args: LogArg[]): void {
        console.debug(`${this.prefix()} ${message}`, ...args);
    }

    info(message: string, ...args: LogArg[]): void {
        console.log(`${this.prefix()} ${message}`, ...args);
    }

    warn(message: string, ...args: LogArg[]): void {
        console.warn(`${this.prefix()} ${message}`, ...args);
    }

    error(message: string, ...args: LogArg[]): void {
        console.error(`${this.prefix()} ${message}`, ...args);
    }
}
