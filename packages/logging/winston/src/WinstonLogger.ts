import type { Logger, LogLevel } from '@webpieces/core-util';
import type { Logger as WinstonBase } from 'winston';

/**
 * webpieces LogLevel → winston level name. webpieces `trace` has no native
 * winston counterpart, so it maps onto winston `silly` (the finest npm level);
 * both resolve to GCP severity DEBUG via LEVEL_TO_SEVERITY.
 */
export const LEVEL_TO_WINSTON: Record<LogLevel, string> = {
    trace: 'silly',
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
};

/**
 * WinstonLogger - a webpieces {@link Logger} backed by a winston logger instance
 * (one per name, created as a winston child carrying `loggerName`). Context
 * enrichment is done by the shared winston formats (see format.ts), so this
 * wrapper only maps the 5 webpieces levels and spreads an optional Error into
 * `errName`/`errMessage`/`errStack` — matching the tested monorepo-nx behaviour.
 */
export class WinstonLogger implements Logger {
    constructor(private readonly winston: WinstonBase) {}

    trace(message: string, err?: Error): void {
        this.emit('trace', message, err);
    }

    debug(message: string, err?: Error): void {
        this.emit('debug', message, err);
    }

    info(message: string, err?: Error): void {
        this.emit('info', message, err);
    }

    warn(message: string, err?: Error): void {
        this.emit('warn', message, err);
    }

    error(message: string, err?: Error): void {
        this.emit('error', message, err);
    }

    private emit(level: LogLevel, message: string, err?: Error): void {
        const winstonLevel = LEVEL_TO_WINSTON[level];
        if (err) {
            this.winston.log(winstonLevel, message, {
                errName: err.name,
                errMessage: err.message,
                errStack: err.stack,
            });
        } else {
            this.winston.log(winstonLevel, message);
        }
    }
}
