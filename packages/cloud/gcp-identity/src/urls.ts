import { isOnGcp, readNumericProjectId, readRegion, readProjectId, readRuntimeServiceAccountEmail } from './metadata';

/** Local fallback SA email used off-GCP so 'self' caller checks are deterministic. */
export const LOCAL_SERVICE_ACCOUNT_EMAIL = 'local@localhost.invalid';

/**
 * This service's name from K_SERVICE (Cloud Run sets this), VERBATIM. Off-GCP returns 'local'.
 * Synchronous — env only.
 *
 * There is exactly ONE service name and no prefix rules: the Cloud Run service name is the svcName
 * peers call you by, is what {@link getSelfCloudRunUrl} puts in your own URL, and is what
 * `gcpCloudRunDeriver` puts in theirs. (This used to strip a leading `tf-`, which made a service
 * deployed as `tf-server2` unreachable by the name it reported — the two never agreed.)
 */
export function getServiceName(): string {
    return process.env['K_SERVICE'] ?? 'local';
}

/** GCP project id, or 'local-project' off-GCP. */
export async function getProjectId(): Promise<string> {
    if (!(await isOnGcp())) {
        return 'local-project';
    }
    return readProjectId();
}

/** Cloud Run region, or 'local' off-GCP. */
export async function getRegion(): Promise<string> {
    if (!(await isOnGcp())) {
        return 'local';
    }
    return readRegion();
}

/** The runtime SA email, or the local placeholder off-GCP. */
export async function getRuntimeServiceAccountEmail(): Promise<string> {
    if (!(await isOnGcp())) {
        return LOCAL_SERVICE_ACCOUNT_EMAIL;
    }
    return readRuntimeServiceAccountEmail();
}

/**
 * This service's own base URL (its Cloud Tasks self-enqueue target / public base).
 * Off-GCP → http://localhost:<PORT>.
 */
export async function getSelfCloudRunUrl(): Promise<string> {
    const kService = process.env['K_SERVICE'];
    if (!(await isOnGcp()) || !kService) {
        const port = process.env['PORT'] ?? '8080';
        return `http://localhost:${port}`;
    }
    const numericProjectId = await readNumericProjectId();
    const region = await readRegion();
    return `https://${kService}-${numericProjectId}.${region}.run.app`;
}
