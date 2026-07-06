import { isOnGcp, readNumericProjectId, readRegion, readProjectId, readRuntimeServiceAccountEmail } from './metadata';

/** Local fallback SA email used off-GCP so 'self' caller checks are deterministic. */
export const LOCAL_SERVICE_ACCOUNT_EMAIL = 'local@localhost.invalid';

/**
 * Logical service name from K_SERVICE (Cloud Run sets this), stripping a leading
 * 'tf-' Terraform prefix. Off-GCP returns 'local'. Synchronous — env only.
 */
export function getServiceName(): string {
    const kService = process.env['K_SERVICE'];
    if (!kService) {
        return 'local';
    }
    return kService.startsWith('tf-') ? kService.substring('tf-'.length) : kService;
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

/**
 * Deterministic base URL for another Cloud Run service in the same project/region.
 * Off-GCP returns a non-routable placeholder (in-memory task/rpc dispatch never
 * actually fetches it during tests); a real local multi-service run can override
 * via the CLOUD_RUN_URL_<UPPER_SNAKE_NAME> env var.
 */
export async function getCloudRunUrl(serviceName: string): Promise<string> {
    const override = process.env[`CLOUD_RUN_URL_${toEnvKey(serviceName)}`];
    if (override) {
        return override;
    }
    if (!(await isOnGcp())) {
        return `http://${serviceName}.localhost.invalid`;
    }
    const numericProjectId = await readNumericProjectId();
    const region = await readRegion();
    return `https://${serviceName}-${numericProjectId}.${region}.run.app`;
}

function toEnvKey(serviceName: string): string {
    return serviceName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}
