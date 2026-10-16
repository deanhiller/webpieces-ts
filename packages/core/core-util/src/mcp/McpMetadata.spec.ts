import { describe, expect, it } from 'vitest';
import { READ, WRITE_IDEMPOTENT, WRITE } from '../http/HttpEndpointOptions';
import { getWpMcpTools, mcpHintsForOperation, WpMcpTool } from './McpMetadata';
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
        expect(mcpHintsForOperation(READ, false)).toMatchObject({
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false,
        });
        expect(mcpHintsForOperation(WRITE_IDEMPOTENT, true)).toMatchObject({
            readOnlyHint: false,
            idempotentHint: true,
            destructiveHint: true,
            openWorldHint: true,
        });
        expect(mcpHintsForOperation(WRITE, false)).toMatchObject({
            readOnlyHint: false,
            idempotentHint: false,
            destructiveHint: true,
            openWorldHint: false,
        });
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
