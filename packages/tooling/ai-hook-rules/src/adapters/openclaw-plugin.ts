import * as path from 'path';
import * as fs from 'fs';

import { run } from '../core/runner';
import { NormalizedToolInput, NormalizedEdit, ToolKind } from '../core/types';
import { toError } from '../core/to-error';

interface ToolCallEvent {
    toolName: string;
    // webpieces-disable no-any-unknown -- openclaw SDK passes opaque tool arguments
    arguments: Record<string, unknown>;
}

interface HookContext {
    // webpieces-disable no-any-unknown -- openclaw SDK context shape is opaque
    [key: string]: unknown;
}

class OpenclawHandlerResult {
    readonly status: 'approved' | 'rejected';
    readonly reason: string | undefined;

    constructor(status: 'approved' | 'rejected', reason?: string) {
        this.status = status;
        this.reason = reason;
    }
}

const TOOL_MAP: Record<string, ToolKind> = {
    'write': 'Write',
    'edit': 'Edit',
};

function mapToolName(openclawName: string): ToolKind | null {
    return TOOL_MAP[openclawName] || null;
}

// webpieces-disable no-any-unknown -- openclaw SDK passes opaque tool arguments
function mapToolInput(toolName: string, args: Record<string, unknown>): NormalizedToolInput | null {
    const filePath = typeof args['path'] === 'string' ? args['path'] as string : null;
    if (!filePath) return null;

    if (toolName === 'write') {
        const content = typeof args['content'] === 'string' ? args['content'] as string : '';
        return new NormalizedToolInput(filePath, [new NormalizedEdit('', content)]);
    }
    if (toolName === 'edit') {
        const oldStr = typeof args['old_string'] === 'string' ? args['old_string'] as string : '';
        const newStr = typeof args['new_string'] === 'string' ? args['new_string'] as string : '';
        return new NormalizedToolInput(filePath, [new NormalizedEdit(oldStr, newStr)]);
    }
    return null;
}

function findWorkspaceRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    while (true) {
        if (fs.existsSync(path.join(dir, 'webpieces.ai-hooks.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export default async function handler(
    event: ToolCallEvent,
    _context: HookContext,
): Promise<OpenclawHandlerResult | undefined> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const toolKind = mapToolName(event.toolName);
        if (!toolKind) return undefined;

        const input = mapToolInput(event.toolName, event.arguments);
        if (!input) return undefined;

        const wsRoot = findWorkspaceRoot(input.filePath);
        if (!wsRoot) return undefined;

        const result = run(toolKind, input, wsRoot);
        if (!result) return new OpenclawHandlerResult('approved');
        return new OpenclawHandlerResult('rejected', result.report);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`[ai-hooks] openclaw adapter crashed (failing open): ${error.message}`);
        return undefined;
    }
}
