import { inject, injectable } from 'inversify';
import { provideSingleton, RouteBuilderImpl, MethodMeta } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { LogManager } from '@webpieces/wp-logging';
import { LocalTaskDispatcher } from './TaskTypes';

const log = LogManager.getLogger('LocalTaskDispatcherImpl');

/**
 * Server-side implementation of LocalTaskDispatcher (the seam used by
 * InMemoryTaskInvoker). Runs a delivered cloud task through the REAL per-route filter
 * chain + controller in-process — exactly the path production HTTP delivery takes —
 * so tests exercise ContextFilter + ServiceAuthFilter + the controller for real.
 *
 * Lives here (not http-server) to respect the architecture layering: it only needs
 * http-routing's RouteBuilder, which cloudtasks-client already depends on. Bind it
 * alongside InMemoryTaskInvoker in a test/local container.
 */
@provideSingleton()
@injectable()
export class LocalTaskDispatcherImpl extends LocalTaskDispatcher {
    constructor(
        @inject(RouteBuilderImpl) private readonly routeBuilder: RouteBuilderImpl,
    ) {
        super();
    }

    // webpieces-disable no-any-unknown -- request DTO type is erased at the task boundary
    override async dispatch(path: string, body: unknown, headers: Map<string, string>): Promise<void> {
        const routeMeta = this.routeBuilder.getRouteMeta('POST', path);
        if (!routeMeta) {
            throw new Error(`No route registered for delivered task POST ${path}`);
        }
        const service = this.routeBuilder.createRouteInvoker('POST', path);
        const requestHeaders = this.toHeaderMap(headers);

        log.debug(`dispatching delivered task to ${path} through filter chain`);
        // Fresh RequestContext frame — a delivered task is a NEW request; ContextFilter
        // transfers the synthesized headers (auth + context) into it, just like an HTTP hop.
        await RequestContext.run(async () => {
            const meta = new MethodMeta(routeMeta, requestHeaders, body);
            await service.invoke(meta);
        });
    }

    private toHeaderMap(headers: Map<string, string>): Map<string, string[]> {
        const map = new Map<string, string[]>();
        for (const entry of headers.entries()) {
            map.set(entry[0].toLowerCase(), [entry[1]]);
        }
        return map;
    }
}
