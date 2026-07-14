import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClientRegistry } from '@webpieces/core-util';

// The metadata server is the one thing these specs cannot have, so it is mocked. Everything else —
// the formula, the precedence chain, the off-GCP throw — is exercised for real.
vi.mock('gcp-metadata', () => ({
    project: vi.fn((key: string) => Promise.resolve(key === 'numeric-project-id' ? '85199159477' : 'my-project')),
    instance: vi.fn(() => Promise.resolve('projects/85199159477/regions/us-central1')),
}));

import { gcpCloudRunDeriver, GcpCloudRunTarget } from '../gcpCloudRunDeriver';
import { resetMetadataForTests } from '../metadata';
import { getServiceName, getSelfCloudRunUrl } from '../urls';

/** isOnGcp() is gated on K_SERVICE, and every metadata read is memoized — so reset both per spec. */
function setOnGcp(kService: string | undefined): void {
    if (kService === undefined) {
        delete process.env['K_SERVICE'];
    } else {
        process.env['K_SERVICE'] = kService;
    }
    resetMetadataForTests();
}

beforeEach(() => {
    ClientRegistry.clear();
    setOnGcp(undefined);
});

afterEach(() => {
    setOnGcp(undefined);
    ClientRegistry.clear();
});

/**
 * ONE service name, no prefix rules. The name Cloud Run deployed is the name you report, the name
 * peers call you by, and the name in every URL — your own and theirs. (This used to strip a leading
 * `tf-`, so a service deployed as `tf-server2` reported `server2` and was then unreachable by it.)
 */
describe('getServiceName / getSelfCloudRunUrl', () => {
    it('reports K_SERVICE verbatim', () => {
        setOnGcp('helper-fsdb');
        expect(getServiceName()).toBe('helper-fsdb');
    });

    it('does NOT strip a tf- prefix — the deployed name IS the service name', () => {
        setOnGcp('tf-server2');
        expect(getServiceName()).toBe('tf-server2');
    });

    it("is 'local' off GCP", () => {
        expect(getServiceName()).toBe('local');
    });

    it('self URL agrees with the name reported, prefix and all', async () => {
        setOnGcp('tf-server2');
        expect(await getSelfCloudRunUrl()).toBe(`https://${getServiceName()}-85199159477.us-central1.run.app`);
    });

    it('self URL is localhost off GCP', async () => {
        process.env['PORT'] = '8401';
        expect(await getSelfCloudRunUrl()).toBe('http://localhost:8401');
        delete process.env['PORT'];
    });
});

describe('gcpCloudRunDeriver', () => {
    it('DERIVES <svc>-<projectNumber>.<region>.run.app from the metadata server, on GCP', async () => {
        setOnGcp('helper-portal');

        const url = await gcpCloudRunDeriver()('helper-fsdb');

        expect(url).toBe('https://helper-fsdb-85199159477.us-central1.run.app');
    });

    it('DERIVES the same formula OFF GCP from a supplied target — a CLI/CI calling Cloud Run', async () => {
        // No metadata server on a laptop, but the URL is still deterministic. This is what unbreaks
        // a CLI that used to have to pass a raw URL into the svcName slot.
        const derive = gcpCloudRunDeriver(new GcpCloudRunTarget('85199159477', 'us-central1'));

        expect(await derive('helper-fsdb')).toBe('https://helper-fsdb-85199159477.us-central1.run.app');
    });

    it('THROWS off GCP with no target, naming both fixes', async () => {
        await expect(gcpCloudRunDeriver()('helper-fsdb')).rejects.toThrow(
            /NOT on GCP[\s\S]*GcpCloudRunTarget\(projectNumber, region\)[\s\S]*addUrlMapping/,
        );
    });

    it('never invents a prefix: the svcName IS the Cloud Run service name', async () => {
        const derive = gcpCloudRunDeriver(new GcpCloudRunTarget('85199159477', 'us-central1'));

        expect(await derive('tf-server2')).toBe('https://tf-server2-85199159477.us-central1.run.app');
    });
});

/** The precedence chain, end to end, as a GCP app actually installs it. */
describe('ClientRegistry + gcpCloudRunDeriver', () => {
    it('OVERRIDE: a mapping beats derivation (another region / project / non-Cloud-Run host)', async () => {
        setOnGcp('helper-portal');
        ClientRegistry.setDeriver(gcpCloudRunDeriver());
        ClientRegistry.addUrlMapping('email-svc', 'https://email.other-region.example');

        expect(await ClientRegistry.resolve('email-svc')).toBe('https://email.other-region.example');
    });

    it('DERIVE: an unmapped svcName goes through the deriver', async () => {
        setOnGcp('helper-portal');
        ClientRegistry.setDeriver(gcpCloudRunDeriver());

        expect(await ClientRegistry.resolve('helper-fsdb'))
            .toBe('https://helper-fsdb-85199159477.us-central1.run.app');
    });

    it('THROW: no mapping and no deriver installed is a setup bug, not a silent mis-route', async () => {
        await expect(ClientRegistry.resolve('helper-fsdb')).rejects.toThrow(/No URL for service "helper-fsdb"/);
    });
});
