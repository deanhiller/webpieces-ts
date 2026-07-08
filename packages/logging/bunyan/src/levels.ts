import Logger from 'bunyan';
import type { LogLevel } from '@webpieces/core-util';

/**
 * webpieces LogLevel → bunyan numeric level. webpieces has no `fatal`; its 5
 * levels map onto bunyan TRACE(10)/DEBUG(20)/INFO(30)/WARN(40)/ERROR(50).
 * @google-cloud/logging-bunyan turns these into GCP severities
 * (10/20→DEBUG, 30→INFO, 40→WARNING, 50→ERROR).
 */
export const LEVEL_TO_BUNYAN: Record<LogLevel, number> = {
    trace: Logger.TRACE,
    debug: Logger.DEBUG,
    info: Logger.INFO,
    warn: Logger.WARN,
    error: Logger.ERROR,
};

export function logLevelToBunyanLevel(level: LogLevel): number {
    return LEVEL_TO_BUNYAN[level];
}
