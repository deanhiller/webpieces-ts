import { ServiceUrlDeriver } from '@webpieces/core-util';
import { isOnGcp, readNumericProjectId, readRegion } from './metadata';

/**
 * Where the Cloud Run services being called live, for code that is NOT itself on GCP and therefore
 * has no metadata server to read them from — a CLI on a laptop, a CI job, a test.
 *
 * On GCP you never construct this: `gcpCloudRunDeriver()` reads both values from the metadata server.
 */
export class GcpCloudRunTarget {
    constructor(
        /** The NUMERIC project id (not the project id string) — Cloud Run URLs are built from it. */
        public readonly projectNumber: string,
        /** e.g. 'us-central1'. */
        public readonly region: string,
    ) {}
}

/**
 * The GCP {@link ServiceUrlDeriver}: `svcName` -> `https://<svc>-<projectNumber>.<region>.run.app`.
 *
 * That derived form is a live alias of Cloud Run's hash URL (`<svc>-5s4met7cnq-uc.a.run.app`), so
 * one formula reaches every service in the project+region and you maintain NO url table across
 * demo/qa/prod. `svcName` is the CLOUD RUN SERVICE NAME, verbatim — if you deploy a service as
 * `tf-server2` then its svcName is `tf-server2`. Nothing here strips or adds a prefix.
 *
 * Install it once at startup; it only ever runs for a svcName with no {@link ClientRegistry} mapping:
 *
 * ```ts
 * ClientRegistry.setDeriver(gcpCloudRunDeriver());                                                 // ON GCP
 * ClientRegistry.setDeriver(gcpCloudRunDeriver(new GcpCloudRunTarget('851991', 'us-central1')));  // a CLI
 * ```
 *
 * @param target supply it OFF GCP (where there is no metadata server, but the URL is still
 *        deterministic); omit it ON GCP to read project+region from the metadata server.
 */
// webpieces-disable no-function-outside-class -- a deriver IS a function; this is the factory that closes over the target (see ServiceUrlDeriver)
export function gcpCloudRunDeriver(target?: GcpCloudRunTarget): ServiceUrlDeriver {
    return async (svcName: string): Promise<string> => {
        const resolved = target ?? (await readTargetFromMetadata(svcName));
        return `https://${svcName}-${resolved.projectNumber}.${resolved.region}.run.app`;
    };
}

/** Project + region off the metadata server. Every read is memoized, so only the first call pays. */
// webpieces-disable no-function-outside-class -- module-private helper of the deriver factory above
async function readTargetFromMetadata(svcName: string): Promise<GcpCloudRunTarget> {
    if (!(await isOnGcp())) {
        throw new Error(
            `Cannot derive a Cloud Run URL for "${svcName}": this process is NOT on GCP, so there is no ` +
            `metadata server to read the project number and region from. Off GCP, either supply them — ` +
            `ClientRegistry.setDeriver(gcpCloudRunDeriver(new GcpCloudRunTarget(projectNumber, region))) — ` +
            `or register the URL: ClientRegistry.addUrlMapping('${svcName}', 'https://...').`,
        );
    }
    const projectNumber = await readNumericProjectId();
    const region = await readRegion();
    return new GcpCloudRunTarget(projectNumber, region);
}
