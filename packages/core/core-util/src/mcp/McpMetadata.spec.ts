import { describe, expect, it } from 'vitest';
import { READ, WRITE_IDEMPOTENT, WRITE } from '../http/HttpEndpointOptions';
import { getWpMcpTools, mcpHintsForOperation, WpMcpTool } from './McpMetadata';
import { WpMcpToolMetadata } from './McpMetadata';
import { Mcp, WpMcpToolOptions } from './Mcp';

describe('MCP profile declarations', () => {
    it('defaults only on omission and snapshots explicit membership', () => {
        const profiles = ['admin', Mcp.DEFAULT];
        abstract class ProfileApi {
            @WpMcpTool('implicit', 'Implicit')
            implicit(_request: object): Promise<object> {
                throw new Error('contract');
            }
            @WpMcpTool('omitted', 'Omitted', {})
            omitted(_request: object): Promise<object> {
                throw new Error('contract');
            }
            @WpMcpTool('admin', 'Admin', { profiles: ['admin'] })
            admin(_request: object): Promise<object> {
                throw new Error('contract');
            }
            @WpMcpTool('shared', 'Shared', { profiles })
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
            expect(() => WpMcpTool('tool', 'Title', { profiles })).toThrow(/profiles|profile/);
        },
    );

    it.each([null, [], 'admin', { roles: ['admin'] }, { profiles: undefined }, { profiles: [1] }])(
        'rejects malformed options %j',
        (options: object | string | null) => {
            expect(() => WpMcpTool('tool', 'Title', options as WpMcpToolOptions)).toThrow(
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

describe('@WpMcpTool title (#1180)', () => {
    it('records the human-readable title beside the stable name', () => {
        abstract class TitledApi {
            @WpMcpTool('learner_get_passages', 'Get your passages')
            getPassages(_request: object): Promise<object> {
                throw new Error('contract only');
            }
        }

        const [tool] = getWpMcpTools(TitledApi);
        expect(tool?.name).toBe('learner_get_passages');
        expect(tool?.title).toBe('Get your passages');
    });

    it('THROWS at decoration time on an empty or whitespace title, naming the fix', () => {
        expect(() => WpMcpTool('learner_get_passages', '')).toThrow(
            /non-empty human-readable title/,
        );
        expect(() => WpMcpTool('learner_get_passages', '   ')).toThrow(
            /@WpMcpTool\('learner_get_passages', \.\.\.\)/,
        );
    });
});
