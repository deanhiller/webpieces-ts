/**
 * A generator the `openapi-generate` / `docs-generate` executors RUN but never bundle, and the oldest
 * release of it that has every capability the executor relies on. Data-only.
 *
 * `minimumVersion` is the version handshake. A capability ships in the generator (the server stream)
 * first; the executor that relies on it follows, and raises this number in the same change. Keep it the
 * FIRST release carrying the capability, not the latest one — raising it further forces a consumer bump
 * that buys nothing.
 */
export class GeneratorPackage {
    constructor(
        readonly packageName: string,
        readonly binName: string,
        readonly minimumVersion: string,
    ) {}
}

/**
 * `wp-openapi` with `--manifest/--out/--format`, writing ONE MCP tool catalog PER CONTRACT
 * (`mcp-<ContractClass>-tools.json`, #1021). 0.4.812 is the first release carrying that layout; an
 * older generator writes the single `mcp-tools.json` no server of this release reads.
 */
export const OPENAPI_GENERATOR = new GeneratorPackage('@webpieces/openapi-generator', 'wp-openapi', '0.4.812');

/** `wp-docs-site --spec/--prose/--out`: 0.4.807 is the first release carrying the docs site (#1007). */
export const DOCS_SITE = new GeneratorPackage('@webpieces/docs-site', 'wp-docs-site', '0.4.807');
