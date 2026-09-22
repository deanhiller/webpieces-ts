import { describe, expect, it } from 'vitest';
import { READ, WRITE_IDEMPOTENT, WRITE } from '../http/HttpEndpointOptions';
import { mcpHintsForOperation } from './McpMetadata';

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
