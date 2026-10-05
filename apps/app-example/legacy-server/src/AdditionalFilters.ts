import type { FilterDefinition, RouteModule, WebpiecesRouter } from '@webpieces/http-routing';
/** Runtime-only filter inventory; it contributes no API relationships. */
export class AdditionalFilters implements RouteModule {
    constructor(private readonly filters: FilterDefinition[]) {}
    configure(router: WebpiecesRouter): void {
        for (const filter of this.filters) router.addFilter(filter);
    }
}
