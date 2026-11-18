import { specTempDirs } from '@webpieces/tooling-testkit';
/**
 * The compact markdown views of the architecture JSON (#1429): the EXACT bytes a small fixture graph
 * renders to, written from the committed files, and the drift check validate-architecture-unchanged
 * runs against them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import type { EnhancedGraph } from '../graph-sorter';
import { saveGraph } from '../graph-loader';
import { saveRuntimeGraph } from '../runtime-graph-io';
import type { RuntimeGraph } from '../runtime-graph-model';
import { ArchitectureMarkdownFiles, MarkdownDrift } from '../architecture-markdown';

let root: string;

beforeEach(() => {
    root = specTempDirs.make('wp-arch-md-');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function buildGraph(): EnhancedGraph {
    return {
        '@acme/order-server': {
            level: 3,
            role: 'server',
            dependsOn: ['lib-a', '@acme/order-api'],
            responsibilitiesFile: 'services/order-server/responsibilities.md',
        },
        'billing-worker': {
            level: 3,
            role: 'server',
            dependsOn: ['@acme/order-api'],
            responsibilitiesFile: 'services/billing/responsibilities.md',
        },
        '@acme/order-api': {
            level: 1,
            role: 'api-lib',
            dependsOn: ['core'],
            responsibilitiesFile: 'libraries/apis/order-api/responsibilities.md',
        },
        'lib-a': {
            level: 1,
            role: 'lib',
            dependsOn: ['core'],
            responsibilitiesFile: 'libraries/lib-a/docs/RESPONSIBILITIES.md',
        },
        core: {
            level: 0,
            role: 'lib',
            dependsOn: [],
            responsibilitiesFile: 'libraries/core-util/responsibilities.md',
        },
    };
}

function runtimeGraph(): RuntimeGraph {
    const at = (level: number): { level: number; levelBecause: string } => ({ level, levelBecause: 'fixture' });
    return {
        maxLevel: 3,
        contractQueues: {},
        services: {
            web: { ...at(3), role: 'client', implements: [], uses: ['OrderApi', 'StorageApi'], dependsOn: [] },
            '@acme/order-server': {
                ...at(2),
                role: 'server',
                implements: ['OrderApi'],
                implementsVia: { OrderApi: 'lib-a' },
                uses: ['BillingApi'],
                dependsOn: [],
            },
            'billing-worker': { ...at(1), role: 'server', implements: ['BillingApi'], uses: [], dependsOn: [] },
        },
        apis: {
            OrderApi: { implementedBy: ['@acme/order-server'], usedBy: ['web'], type: 'rpc', owner: '@acme/order-api' },
            BillingApi: { implementedBy: ['billing-worker'], usedBy: ['@acme/order-server'], type: 'pubsub' },
            StorageApi: { implementedBy: [], usedBy: ['web'], type: 'rpc', owner: '@acme/storage-api' },
        },
        runtimeEdges: [
            { from: 'web', to: '@acme/order-server', via: ['OrderApi'], type: 'rpc' },
            { from: '@acme/order-server', to: 'billing-worker', via: ['BillingApi'], type: 'pubsub', queue: 'BillingApi.charge' },
        ],
        unresolvedUses: [{ ...at(0), service: 'web', api: 'StorageApi' }],
        queues: {
            'BillingApi.charge': {
                ...at(2),
                api: 'BillingApi',
                method: 'charge',
                queueName: 'billing-charge',
                selfQueue: false,
                producedBy: ['@acme/order-server'],
                consumedBy: ['billing-worker'],
            },
        },
        triggers: [
            { ...at(3), kind: 'external', api: 'OrderApi', method: 'webhook', service: '@acme/order-server', caller: { kind: 'saas', label: 'twilio' } },
            { ...at(2), kind: 'cron', api: 'BillingApi', method: 'sweep', service: 'billing-worker', queueName: 'billing-sweep' },
        ],
        externalSystems: {
            postgres: { ...at(0), kind: 'database', label: 'postgres', usedBy: ['billing-worker'], apis: [] },
        },
        remoteServices: {
            'legacy-billing': {
                ...at(0),
                label: 'Legacy billing VM',
                implements: ['InvoiceApi (rpc)'],
                calledBy: [{ from: 'billing-worker', via: ['InvoiceApi'], type: 'rpc' }],
            },
        },
    };
}

function writeCommittedJson(): void {
    saveGraph(buildGraph(), root);
    saveRuntimeGraph(runtimeGraph(), root);
}

const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf-8');

/** The RuleFailError `run` throws (the test fails when it throws anything else, or nothing). */
async function failureOf(run: () => void): Promise<RuleFailError> {
    const thrown = await Promise.resolve().then(run).then(
        (): unknown => null,
        (err: unknown): unknown => err,
    );
    expect(thrown).toBeInstanceOf(RuleFailError);
    return thrown as RuleFailError;
}

const EXPECTED_BUILD = `# Build dependencies (generated — do not edit)

Generated from \`dependencies.json\` by \`pnpm nx run architecture:generate\`; the JSON stays the source for queries.
One line per project, deepest level first: \`<dir> [<role> L<level>]: <deps>\` (\`-\` = none).
A dep is a project name: the last segment of its \`<dir>\`, unless its line reads \`<dir> (<name>)\`.
Before adding code to a project, read \`<dir>/responsibilities.md\` (exceptions are indexed at the end).

\`\`\`text
services/billing (billing-worker) [server L3]: order-api
services/order-server [server L3]: lib-a, order-api
libraries/apis/order-api [api-lib L1]: core
libraries/lib-a/docs (lib-a) [lib L1]: core
libraries/core-util (core) [lib L0]: -
\`\`\`

## Responsibilities files not at \`<dir>/responsibilities.md\`

\`\`\`text
lib-a=libraries/lib-a/docs/RESPONSIBILITIES.md
\`\`\`
`;

const EXPECTED_RUNTIME = `# Runtime dependencies (generated — do not edit)

Generated from \`runtime-dependencies.json\` by \`pnpm nx run architecture:generate\`; the JSON stays the source for queries.
Covers webpieces services only. Calls to or from non-webpieces services are not shown, so a missing edge
means "not modelled", not "no call"; the outside callees we do know of are under "Not modelled here".
Names are project names, as in \`build-deps.md\`.

## Service calls

\`\`\`text
order-server -pubsub-> billing-worker [BillingApi] queue=billing-charge
web -rpc-> order-server [OrderApi]
\`\`\`

## Triggers

\`\`\`text
cron billing-worker.BillingApi.sweep (billing-sweep)
external order-server.OrderApi.webhook (from saas twilio)
\`\`\`

## Not modelled here (outbound calls to remote services, external systems and unresolved APIs)

\`\`\`text
billing-worker -> database postgres
billing-worker -rpc-> legacy-billing [InvoiceApi] (remote service)
web -> StorageApi (owner storage-api)
\`\`\`

## Services

\`\`\`text
web [client L3]: -
order-server [server L2]: OrderApi
billing-worker [server L1]: BillingApi
\`\`\`
`;

describe('architecture markdown views (#1429)', () => {
    it('renders build-deps.md exactly: dir-keyed lines, deepest first, short dep names, off-convention index', () => {
        writeCommittedJson();
        new ArchitectureMarkdownFiles().write(root);
        expect(read('architecture/build-deps.md')).toBe(EXPECTED_BUILD);
    });

    it('renders runtime-deps.md exactly: calls (pubsub with its queue), triggers, outbound, services — no *Via provenance', () => {
        writeCommittedJson();
        const written = new ArchitectureMarkdownFiles().write(root);
        expect(written).toEqual(['architecture/build-deps.md', 'architecture/runtime-deps.md']);
        expect(read('architecture/runtime-deps.md')).toBe(EXPECTED_RUNTIME);
        expect(read('architecture/runtime-deps.md')).not.toContain('lib-a');
    });

    it('keeps the full key for two projects whose short names collide', () => {
        const graph = buildGraph();
        graph['core'].dependsOn = ['@other/core'];
        graph['@other/core'] = { level: 0, dependsOn: [], role: 'lib', responsibilitiesFile: 'vendor/core/responsibilities.md' };
        saveGraph(graph, root);
        new ArchitectureMarkdownFiles().write(root);
        expect(read('architecture/build-deps.md')).toContain('libraries/core-util (core) [lib L0]: @other/core\n');
        expect(read('architecture/build-deps.md')).toContain('vendor/core (@other/core) [lib L0]: -\n');
    });
});

describe('the drift check validate-architecture-unchanged runs (#1429)', () => {
    it('passes when the committed views are exactly the render of the committed JSON', () => {
        writeCommittedJson();
        const files = new ArchitectureMarkdownFiles();
        files.write(root);
        expect(files.drift(root)).toEqual([]);
        expect(() => files.assertMatchesCommitted(root)).not.toThrow();
    });

    it('fails naming the hand-edited file and the regenerate command', async () => {
        writeCommittedJson();
        const files = new ArchitectureMarkdownFiles();
        files.write(root);
        fs.appendFileSync(path.join(root, 'architecture/runtime-deps.md'), 'hand edit\n');
        const error = await failureOf(() => files.assertMatchesCommitted(root));
        expect(error.ruleName).toBe('validate-architecture-unchanged');
        const rendered = renderRuleFailForHuman(error);
        expect(rendered).toContain('architecture/runtime-deps.md: differs from the render of the committed JSON');
        expect(rendered).not.toContain('architecture/build-deps.md:');
        expect(rendered).toContain('Run pnpm nx run architecture:generate, then commit architecture/runtime-deps.md.');
    });

    it('fails naming a view that is missing', async () => {
        writeCommittedJson();
        const error = await failureOf(() => new ArchitectureMarkdownFiles().assertMatchesCommitted(root));
        const rendered = renderRuleFailForHuman(error);
        expect(rendered).toContain('architecture/build-deps.md: missing');
        expect(rendered).toContain('architecture/runtime-deps.md: missing');
    });

    it('fails when the JSON moved on but the view was not regenerated', () => {
        writeCommittedJson();
        const files = new ArchitectureMarkdownFiles();
        files.write(root);
        const graph = buildGraph();
        graph['lib-a'].dependsOn = [];
        saveGraph(graph, root);
        const drifted = files.drift(root).map((d: MarkdownDrift): string => `${d.file}:${d.reason}`);
        expect(drifted).toEqual(['architecture/build-deps.md:differs']);
    });
});
