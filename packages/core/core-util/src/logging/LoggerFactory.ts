import { Logger } from './Logger';

/**
 * LoggerFactory - the pluggable seam that produces named {@link Logger}s.
 *
 * BUSINESS-LOGIC interface (a method with behavior). An app selects its logging
 * backend by installing one implementation of this factory globally via
 * {@link LogManager.setFactory}. Everything else in the codebase asks
 * {@link LogManager.getLogger} for a named logger and never knows which backend
 * is behind it.
 *
 * `name` is conventionally the class or module name (slf4j style), e.g.
 * `LogManager.getLogger('LogApiCall')`.
 */
export interface LoggerFactory {
    getLogger(name: string): Logger;
}
