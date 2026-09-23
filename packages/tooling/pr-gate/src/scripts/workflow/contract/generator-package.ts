/**
 * A generator this tooling RUNS but never bundles, and the oldest release of it that has every
 * capability the tooling relies on. Data-only.
 *
 * `minimumVersion` is the version handshake. A capability ships in the generator (the server stream)
 * first; the tooling that relies on it follows, and raises this number in the same change. Keep it the
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
 * `wp-openapi` with `--manifest/--out/--format` and the `mcp-tools.json` runtime catalog: 0.4.807 is
 * the first release carrying #1008, which is when `mcp-tools.json` became part of what a run writes.
 */
export const OPENAPI_GENERATOR = new GeneratorPackage('@webpieces/openapi-generator', 'wp-openapi', '0.4.807');

/** `wp-docs-site --spec/--prose/--out`: 0.4.807 is the first release carrying the docs site (#1007). */
export const DOCS_SITE = new GeneratorPackage('@webpieces/docs-site', 'wp-docs-site', '0.4.807');

/** The executor a project declares to have its documents generated — and therefore diffed in its PRs. */
export const OPENAPI_GENERATE_EXECUTOR = '@webpieces/nx-webpieces-rules:openapi-generate';

/**
 * The partner-facing document: every contract declaring `EXTERNAL_CUSTOMER`, minus hidden methods. It is
 * the one the PR gate diffs, because it is the one that leaves the building as a published contract.
 */
export const PARTNER_DOCUMENT = 'public-openapi.json';
