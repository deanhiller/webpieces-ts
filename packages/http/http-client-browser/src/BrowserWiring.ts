/** A framework-owned provider list; no Angular or Node runtime is imported here. */
export class BrowserWiring<P> {
    constructor(private readonly providers: readonly P[]) {}

    toProviders(): P[] {
        return [...this.providers];
    }
}
