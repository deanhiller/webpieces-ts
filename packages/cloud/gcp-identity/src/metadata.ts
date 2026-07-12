import * as gcpMetadata from 'gcp-metadata';

/**
 * Cached reads of the GCP metadata server. Every value is fetched at most once per
 * process (the metadata server is stable for the life of the instance). Off-GCP
 * `isOnGcp()` is false and the callers fall back to localhost values, so nothing
 * here is ever reached in local dev / tests.
 *
 * `isOnGcp()` is decided from the `K_SERVICE` env var (which Cloud Run always sets),
 * NOT a metadata network probe — so local dev never blocks on the ~3s
 * `gcpMetadata.isAvailable()` timeout. Every caller (project id, region, Cloud Run URL
 * resolution, OIDC minting, Cloud Tasks) short-circuits through this one gate.
 */

let cachedOnGcp: Promise<boolean> | undefined;
let cachedProjectId: Promise<string> | undefined;
let cachedNumericProjectId: Promise<string> | undefined;
let cachedRegion: Promise<string> | undefined;
let cachedSaEmail: Promise<string> | undefined;

/**
 * True when running on GCP Cloud Run. Gated on `K_SERVICE` (set by Cloud Run) so local dev does NO
 * metadata network probe. For non-Cloud-Run GCP (GCE / Cloud Functions, which don't set `K_SERVICE`),
 * set `METADATA_SERVER_DETECTION=assume-present` to force on-GCP behavior.
 */
export function isOnGcp(): Promise<boolean> {
    if (!cachedOnGcp) {
        const onGcp =
            process.env['K_SERVICE'] !== undefined ||
            process.env['METADATA_SERVER_DETECTION'] === 'assume-present';
        cachedOnGcp = Promise.resolve(onGcp);
    }
    return cachedOnGcp;
}

// gcp-metadata returns loosely-typed values; coerce every metadata read to a string
// through this one helper so the rest of the file stays strongly typed.
// webpieces-disable no-any-unknown -- single coercion point for gcp-metadata's loose return type
function asString(value: unknown): string {
    return String(value);
}

/** GCP project id (e.g. 'my-project'). Only call when isOnGcp() is true. */
export function readProjectId(): Promise<string> {
    if (!cachedProjectId) {
        cachedProjectId = gcpMetadata.project('project-id').then(asString);
    }
    return cachedProjectId;
}

/** Numeric project id (used to build Cloud Run URLs). */
export function readNumericProjectId(): Promise<string> {
    if (!cachedNumericProjectId) {
        cachedNumericProjectId = gcpMetadata.project('numeric-project-id').then(asString);
    }
    return cachedNumericProjectId;
}

/** Cloud Run region (e.g. 'us-central1'), parsed from 'projects/<num>/regions/<region>'. */
export function readRegion(): Promise<string> {
    if (!cachedRegion) {
        cachedRegion = gcpMetadata.instance('region').then(asString).then((raw: string) => {
            const idx = raw.lastIndexOf('/');
            return idx >= 0 ? raw.substring(idx + 1) : raw;
        });
    }
    return cachedRegion;
}

/** The service-account email this process runs as. */
export function readRuntimeServiceAccountEmail(): Promise<string> {
    if (!cachedSaEmail) {
        cachedSaEmail = gcpMetadata.instance('service-accounts/default/email').then(asString);
    }
    return cachedSaEmail;
}
