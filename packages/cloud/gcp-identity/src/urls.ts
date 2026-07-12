import { ClientRegistry } from '@webpieces/core-util';
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
 * Resolve the base URL a client should call for `svcName`. The ONE resolver every RPC / Cloud Tasks
 * client uses. Precedence:
 *
 *   1. A {@link ClientRegistry} override wins — this is how you reach anything the derivation cannot
 *      describe: a localhost port, another region, another project, a non-Cloud-Run host. Each
 *      environment populates the registry from its own per-env config.
 *   2. Otherwise, on GCP the URL is DERIVED from the Cloud Run service name + project + region
 *      (via {@link isOnGcp}) — same project, same region, zero maintenance across demo/qa/prod.
 *   3. Otherwise (off-GCP and unregistered) it THROWS — a missing mapping is a setup bug, not a
 *      silent mis-route.
 *
 * So clients carry ONLY a `svcName`; there is no per-client `targetUrl` (a client is built once but a
 * URL is per-environment — that belongs in the registry, not on the client).
 */
// webpieces-disable no-function-outside-class -- pure GCP url helper; every sibling in this module is a free function
export async function resolveServiceUrl(svcName: string): Promise<string> {
    const override = ClientRegistry.tryLookup(svcName);
    if (override) {
        return override;
    }
    if (!(await isOnGcp())) {
        throw new Error(
            `No URL for service "${svcName}". On GCP it is derived from the Cloud Run service name; ` +
            `off-GCP register it: ClientRegistry.addMapping(svcName, port) or addUrlMapping(svcName, url).`,
        );
    }
    const numericProjectId = await readNumericProjectId();
    const region = await readRegion();
    return `https://${svcName}-${numericProjectId}.${region}.run.app`;
}
