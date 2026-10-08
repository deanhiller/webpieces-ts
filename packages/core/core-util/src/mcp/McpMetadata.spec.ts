import { describe, expect, it } from 'vitest';
import { READ, WRITE_IDEMPOTENT, WRITE } from '../http/HttpEndpointOptions';
import { getWpMcpTools, mcpHintsForOperation, WpMcpTool } from './McpMetadata';

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
        expect(() => WpMcpTool('learner_get_passages', '')).toThrow(/non-empty human-readable title/);
        expect(() => WpMcpTool('learner_get_passages', '   ')).toThrow(
            /@WpMcpTool\('learner_get_passages', \.\.\.\)/,
        );
    });
});
