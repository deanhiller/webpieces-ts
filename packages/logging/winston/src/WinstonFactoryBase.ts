import { createLogger, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import type { Format } from 'logform';
import type { Logger, LoggerFactory } from '@webpieces/core-util';
import { WinstonLogger } from './WinstonLogger';
import { WinstonFactoryOptions } from './WinstonFactoryOptions';

/**
 * WinstonFactoryBase - shared plumbing for the winston {@link LoggerFactory}
 * backends. Builds ONE underlying winston logger (a single `Console` transport,
 * handleExceptions/Rejections on) with the caller-chosen format stack, then hands
 * out a cached {@link WinstonLogger} per name (each a winston child carrying
 * `loggerName`). Subclasses differ only in the format stack they pass up.
 */
export abstract class WinstonFactoryBase implements LoggerFactory {
    private readonly base: WinstonBase;
    private readonly loggers = new Map<string, Logger>();

    protected constructor(finalFormat: Format, opts: WinstonFactoryOptions) {
        // No level set — we do NOT filter; that is winston's job (defaults to 'info').
        this.base = createLogger({
            format: finalFormat,
            defaultMeta: opts.svcGitHash ? { svcGitHash: opts.svcGitHash } : undefined,
            transports: [new transports.Console()],
            handleExceptions: true,
            handleRejections: true,
        });
    }

    getLogger(name: string): Logger {
        let logger = this.loggers.get(name);
        if (!logger) {
            logger = new WinstonLogger(this.base.child({ loggerName: name }));
            this.loggers.set(name, logger);
        }
        return logger;
    }
}
