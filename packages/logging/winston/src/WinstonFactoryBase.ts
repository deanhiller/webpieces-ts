import { createLogger, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import type { Format } from 'logform';
import type { Logger, LoggerFactory } from '@webpieces/core-util';
import { ServiceInfo } from '@webpieces/core-util';
import { WinstonLogger } from './WinstonLogger';

/**
 * WinstonFactoryBase - shared plumbing for the winston {@link LoggerFactory}
 * backends. Builds ONE underlying winston logger (a single `Console` transport,
 * handleExceptions/Rejections on) with the caller-chosen format stack, then hands
 * out a cached {@link WinstonLogger} per name (each a winston child carrying
 * `loggerName`). Subclasses differ only in the format stack they pass up.
 *
 * Every line carries `svcName` + `version` from {@link ServiceInfo}. Neither used to be a property
 * of the SERVICE: winston has no mandatory logger name (so this backend emitted none — a winston
 * service was distinguishable only by GCP's own resource labels), and the version lived here as an
 * optional `svcGitHash` factory option that bunyan had no counterpart for. Both now come from the
 * ONE {@link ServiceInfo}, so the fields on your logs no longer depend on which logging library the
 * app happened to pick. `version` is opaque — whatever string the app used to identify its build.
 */
export abstract class WinstonFactoryBase implements LoggerFactory {
    private readonly base: WinstonBase;
    private readonly loggers = new Map<string, Logger>();

    protected constructor(finalFormat: Format) {
        // Read at STARTUP (this ctor runs while booting), so a forgotten ServiceInfo.setInfo(...)
        // fails the deploy rather than shipping logs that cannot say which build emitted them.
        const defaultMeta: Record<string, string> = {
            svcName: ServiceInfo.getName(),
            version: ServiceInfo.getVersion(),
        };

        // No level set — we do NOT filter; that is winston's job (defaults to 'info').
        this.base = createLogger({
            format: finalFormat,
            defaultMeta: defaultMeta,
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
