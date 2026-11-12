import { describe, expect, it } from 'vitest';
import { READ, WRITE_IDEMPOTENT, WRITE } from '../http/HttpEndpointOptions';
import {
    getWpMcpTools,
    mcpHintsForOperation,
    operationForMcpHints,
    UNKNOWN_OPERATION,
    WpMcpTool,
    WpMcpToolHints,
} from './McpMetadata';
import { EndpointOperation } from '../http/HttpEndpointOptions';
import { WpMcpToolMetadata } from './McpMetadata';
import { Mcp, McpToolProfilesOptions } from './Mcp';

describe('MCP profile declarations', () => {
    it('defaults only on omission and snapshots explicit membership', () => {
        const profiles: [string, ...string[]] = ['admin', Mcp.DEFAULT];
        abstract class ProfileApi {
            @WpMcpTool('implicit')
            implicit(_request: object): Promise<object> {
                throw new Error('contract');
            }
            @WpMcpTool('omitted', {})
            omitted(_request: object): Promise<object> {
                throw new Error('contract');
            }
            @WpMcpTool('admin', { profiles: ['admin'] })
            admin(_request: object): Promise<object> {
                throw new Error('contract');
            }
            @WpMcpTool('shared', { profiles })
            shared(_request: object): Promise<object> {
                throw new Error('contract');
            }
        }
        profiles.push('other');
        expect(getWpMcpTools(ProfileApi).map((tool: WpMcpToolMetadata) => tool.profiles)).toEqual([
            [Mcp.DEFAULT],
            [Mcp.DEFAULT],
            ['admin'],
            ['admin', Mcp.DEFAULT],
        ]);
        expect(Object.isFrozen(getWpMcpTools(ProfileApi)[3].profiles)).toBe(true);
    });

    it.each([[], [''], [' '], ['Admin'], ['/admin'], ['admin', 'admin'], ['x'.repeat(65)]])(
        'rejects invalid membership %j',
        (profiles: string[]) => {
            expect(() => WpMcpTool('tool', { profiles } as McpToolProfilesOptions)).toThrow(/profiles|profile/);
        },
    );

    it.each([null, [], 'admin', { roles: ['admin'] }, { profiles: undefined }, { profiles: [1] }])(
        'rejects malformed options %j',
        (options: object | string | null) => {
            expect(() => WpMcpTool('tool', options as McpToolProfilesOptions)).toThrow(
                /options|profiles|profile/,
            );
        },
    );
});

describe('MCP hints derived from endpoint operation', () => {
    it('maps read, idempotent write, and non-idempotent write without a second declaration', () => {
        expect(mcpHintsForOperation(READ, false, false)).toMatchObject({
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false,
        });
        expect(mcpHintsForOperation(WRITE_IDEMPOTENT, true, false)).toMatchObject({
            readOnlyHint: false,
            idempotentHint: true,
            destructiveHint: true,
            openWorldHint: true,
        });
        expect(mcpHintsForOperation(WRITE, false, false)).toMatchObject({
            readOnlyHint: false,
            idempotentHint: false,
            destructiveHint: true,
            openWorldHint: false,
        });
    });
});

describe('additive writes and the reverse mapping (#1422)', () => {
    it('lowers destructiveHint for an additive WRITE / WRITE_IDEMPOTENT and changes nothing else', () => {
        for (const operation of [WRITE, WRITE_IDEMPOTENT]) {
            for (const openWorld of [false, true]) {
                const destructive = mcpHintsForOperation(operation, openWorld, false);
                const additive = mcpHintsForOperation(operation, openWorld, true);
                expect(destructive.destructiveHint).toBe(true);
                expect(additive).toEqual(
                    new WpMcpToolHints(
                        destructive.readOnlyHint,
                        false,
                        destructive.idempotentHint,
                        destructive.openWorldHint,
                    ),
                );
            }
        }
    });

    it('rejects additive on a READ, which changes nothing', () => {
        expect(() => mcpHintsForOperation(READ, false, true)).toThrow(
            /only on a WRITE or WRITE_IDEMPOTENT/,
        );
    });

    it('reverses every combination mcpHintsForOperation can produce', () => {
        const cases: Array<[EndpointOperation, boolean]> = [
            [READ, false],
            [WRITE_IDEMPOTENT, false],
            [WRITE_IDEMPOTENT, true],
            [WRITE, false],
            [WRITE, true],
        ];
        for (const [operation, additive] of cases) {
            for (const openWorld of [false, true]) {
                const hints = mcpHintsForOperation(operation, openWorld, additive);
                expect(operationForMcpHints(hints)).toBe(operation);
            }
        }
    });

    it('answers UNKNOWN when a server sent no annotations, or no readOnlyHint', () => {
        expect(operationForMcpHints(undefined)).toBe(UNKNOWN_OPERATION);
        expect(operationForMcpHints({})).toBe(UNKNOWN_OPERATION);
        expect(operationForMcpHints({ idempotentHint: true })).toBe(UNKNOWN_OPERATION);
        expect(operationForMcpHints({ readOnlyHint: false })).toBe(WRITE);
    });
});

describe('@WpMcpTool name (#1296)', () => {
    it('records the stable name and nothing else — the title is the method\'s summary JSDoc tag', () => {
        abstract class NamedApi {
            @WpMcpTool('learner_get_passages')
            getPassages(_request: object): Promise<object> {
                throw new Error('contract only');
            }
        }

        const [tool] = getWpMcpTools(NamedApi);
        expect(tool?.name).toBe('learner_get_passages');
        expect(Object.keys(tool ?? {})).toEqual(['methodName', 'name', 'profiles']);
    });

    it('THROWS at decoration time on a name the Connectors Directory would refuse, naming the fix', () => {
        expect(() => WpMcpTool('')).toThrow(/is empty/);
        expect(() => WpMcpTool('x'.repeat(65))).toThrow(/65 characters, over the 64-character limit/);
        expect(() => WpMcpTool('learner.get')).toThrow(/outside A-Z a-z 0-9 _ -/);
        expect(() => WpMcpTool('x'.repeat(64))).not.toThrow();
    });

    it('refuses a title passed where the options object goes, naming where the title lives now', () => {
        // webpieces-disable no-any-unknown -- deliberately smuggling the retired title past the type checker
        const retiredTitle = 'Get your passages' as unknown as McpToolProfilesOptions;
        expect(() =>
            WpMcpTool('learner_get_passages', retiredTitle),
        ).toThrow(/@summary JSDoc tag/);
    });
});
