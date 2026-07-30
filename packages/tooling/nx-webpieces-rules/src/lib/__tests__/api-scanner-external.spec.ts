/**
 * Vendor seams: the contracts a repo calls that lead OUT of it (firestore, gmail, gcp-storage, ...).
 *
 * These cannot be detected the way in-repo contracts are. A vendor contract is a plain `interface`
 * bound to a Symbol token and injected — it carries no @ApiPath (there is no route; the call leaves
 * through a vendor SDK) and it never appears at a `createRpcClient` call site. So the whole seam was
 * invisible to the runtime graph, which stopped one hop short of the systems that actually page you.
 *
 * The signal is instead: a project the workspace DECLARED external (`externalApiPaths`), an exported
 * `*Api` type in it, and a constructor parameter somewhere typed with that contract.
 *
 * Builds a throwaway mini-workspace on disk, matching api-scanner-no-paths.spec.ts, because the
 * scanner walks real project roots.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner, buildApiContracts, describeMismatchedEndpointKinds } from '../api-usage/api-scanner';
import { ApiRelation } from '../api-usage/api-relations';

let root = '';

function write(relPath: string, contents: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

function tsconfig(relDir: string): void {
    write(
        `${relDir}/tsconfig.json`,
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/**
 * The vendor wrapper lib: contract + config + DTO + the adapter that IS the seam. Only `GmailApi`
 * may be picked up — `GmailConfig` and `GmailMessageDto` are not contracts, and `GmailClient` is the
 * implementation, not a caller.
 */
function writeVendorLib(): void {
    write(
        'libraries/apis/external/gmail/src/index.ts',
        `export interface GmailApi {
    watch(topic: string): Promise<void>;
}

export interface GmailConfig {
    clientId: string;
}

export interface GmailMessageDto {
    id: string;
}

export class GmailClient implements GmailApi {
    constructor(private readonly config: GmailConfig) {}
    async watch(_topic: string): Promise<void> {
        return undefined;
    }
}
`,
    );
    tsconfig('libraries/apis/external/gmail');
}

/** A service that INJECTS the vendor contract — the shape that must become a `uses`. */
function writeService(): void {
    write(
        'services/mail-svr/src/GmailStreamService.ts',
        `import { GmailApi } from '../../../libraries/apis/external/gmail/src/index';

export class GmailStreamService {
    constructor(private readonly gmail: GmailApi) {}
    async start(): Promise<void> {
        await this.gmail.watch('projects/x/topics/y');
    }
}
`,
    );
    tsconfig('services/mail-svr');
}

/**
 * A test-support lib holding an IN-MEMORY FAKE of the vendor contract. It references GmailApi as
 * heavily as a real caller does, but it IS the seam rather than a user of it — counting it would
 * draw a vendor edge from every service that embeds a fake.
 */
function writeFakeLib(): void {
    write(
        'libraries/test-support/src/InMemoryGmail.ts',
        `import { GmailApi } from '../../apis/external/gmail/src/index';

export class InMemoryGmail implements GmailApi {
    async watch(_topic: string): Promise<void> {
        return undefined;
    }
}
`,
    );
    tsconfig('libraries/test-support');
}

function projects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('lib-gmail', new ProjectInfo('lib-gmail', 'libraries/apis/external/gmail', ['role:lib']));
    infos.set('mail-svr', new ProjectInfo('mail-svr', 'services/mail-svr', ['role:server']));
    infos.set('test-support', new ProjectInfo('test-support', 'libraries/test-support', ['role:lib']));
    return infos;
}

const EXTERNAL_PATHS = ['libraries/apis/external/**'];

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-external-scan-'));
    writeVendorLib();
    writeService();
    writeFakeLib();
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('external api detection', () => {
    it('finds nothing when the workspace declares no externalApiPaths', () => {
        // Opt-in on purpose: there is no safe guess for where vendor wrappers live, and guessing
        // would reclassify ordinary libraries as systems outside the repo.
        const result = new ApiUsageScanner(root, projects()).scan();
        expect(result.apiIndex.get('GmailApi')).toBeUndefined();
        expect(result.relationsByProject.get('mail-svr')).toBeUndefined();
    });

    it('indexes only the exported *Api type in a declared external project', () => {
        const result = new ApiUsageScanner(root, projects(), EXTERNAL_PATHS).scan();
        expect(result.apiIndex.get('GmailApi')?.owner).toBe('lib-gmail');
        expect(result.apiIndex.get('GmailApi')?.type).toBe('external');
        // Config types, DTOs and the client implementation are not contracts.
        expect(result.apiIndex.get('GmailConfig')).toBeUndefined();
        expect(result.apiIndex.get('GmailMessageDto')).toBeUndefined();
        expect(result.apiIndex.get('GmailClient')).toBeUndefined();
    });

    it('records a constructor-injected vendor contract as a `uses`', () => {
        const result = new ApiUsageScanner(root, projects(), EXTERNAL_PATHS).scan();
        const relations = result.relationsByProject.get('mail-svr');
        expect(relations).toBeDefined();
        const uses = relations!['lib-gmail'] as ApiRelation;
        expect(uses.kind).toBe('uses');
        expect(uses.uses).toEqual([{ api: 'GmailApi', type: 'external' }]);
    });

    it('does NOT count a class that IMPLEMENTS the contract — that is the seam, not a caller', () => {
        const result = new ApiUsageScanner(root, projects(), EXTERNAL_PATHS).scan();
        expect(result.relationsByProject.get('test-support')).toBeUndefined();
    });

    it('emits no apiContracts entry for a vendor seam (it has no endpoints)', () => {
        const contracts = buildApiContracts(new ApiUsageScanner(root, projects(), EXTERNAL_PATHS).scan());
        expect(contracts['GmailApi']).toBeUndefined();
    });
});

describe('describeMismatchedEndpointKinds', () => {
    it('flags an rpc endpoint on a @PubSub contract and a cron endpoint on an @Rpc one', () => {
        const problems = describeMismatchedEndpointKinds({
            TaskApi: {
                owner: 'task-api',
                apiKind: 'pubsub',
                basePath: '/task',
                methods: [{ name: 'nope', path: '/nope', kind: 'rpc' }],
            },
            WebApi: {
                owner: 'web-api',
                apiKind: 'rpc',
                basePath: '/web',
                methods: [{ name: 'sweep', path: '/sweep', kind: 'cron', queueName: 'WebApi-sweep' }],
            },
        });
        expect(problems).toHaveLength(2);
        expect(problems[0]).toContain('TaskApi.nope');
        expect(problems[0]).toContain('cloudtasks | cron | external');
        expect(problems[1]).toContain('WebApi.sweep');
        expect(problems[1]).toContain('rpc | external');
    });

    it('accepts external on BOTH kinds — a webhook posts synchronously, a push subscription does not', () => {
        expect(
            describeMismatchedEndpointKinds({
                Hook: {
                    owner: 'a',
                    apiKind: 'rpc',
                    basePath: '/a',
                    methods: [{ name: 'inbound', path: '/in', kind: 'external' }],
                },
                Push: {
                    owner: 'b',
                    apiKind: 'pubsub',
                    basePath: '/b',
                    methods: [{ name: 'notify', path: '/n', kind: 'external' }],
                },
            }),
        ).toEqual([]);
    });
});
