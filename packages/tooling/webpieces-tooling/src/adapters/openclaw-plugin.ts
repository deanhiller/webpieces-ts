import * as path from 'path';
import * as fs from 'fs';

import { CONFIG_FILENAME, renderRuleFailForAi } from '@webpieces/rules-config';
import { SourceHookRules } from '@webpieces/ai-hook-rules';
import { WorkflowHookRules } from '@webpieces/agent-workflow-rules';
import { HookRuleSet, HookFileEvaluation } from '@webpieces/hook-runtime';
import { loadAndValidate } from '@webpieces/rules-config';
import { NormalizedToolInput, NormalizedEdit, ToolKind } from '@webpieces/hook-runtime';
import { InformAiError } from '@webpieces/tooling-common';
import { RuleFailError } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';

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

// webpieces-disable no-function-outside-class -- existing OpenClaw callback and stateless adapter helpers moved intact; the SDK invokes this module function
function mapToolName(openclawName: string): ToolKind | null {
    return TOOL_MAP[openclawName] || null;
}

// webpieces-disable no-any-unknown -- openclaw SDK passes opaque tool arguments
// webpieces-disable no-function-outside-class -- existing OpenClaw callback and stateless adapter helpers moved intact; the SDK invokes this module function
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

// webpieces-disable no-function-outside-class -- existing OpenClaw callback and stateless adapter helpers moved intact; the SDK invokes this module function
function findWorkspaceRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    while (true) {
        if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// webpieces-disable no-function-outside-class -- existing OpenClaw callback and stateless adapter helpers moved intact; the SDK invokes this module function
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

        const loaded = loadAndValidate(wsRoot);
        const source = new SourceHookRules().load(loaded);
        const guards = new WorkflowHookRules().load(loaded);
        const result = new HookFileEvaluation().evaluate(toolKind, input, loaded,
            new HookRuleSet([...source.builtInRules, ...guards.rules, ...source.extensionRules], [...source.configuredRules, ...guards.configuredRules]));
        if (!result) return new OpenclawHandlerResult('approved');
        return new OpenclawHandlerResult('rejected', result.report);
    } catch (err: unknown) {
        const error = toError(err);
        // An escaped RuleFailError or InformAiError carries an AI-readable message; anything else is
        // an unexpected bug. All reject (fail closed).
        let msg: string;
        if (error instanceof RuleFailError) {
            msg = renderRuleFailForAi(error);
        } else if (error instanceof InformAiError) {
            msg = error.message;
        } else {
            msg = `[ai-hooks] openclaw adapter crashed — failing closed: ${error.message}`;
        }
        return new OpenclawHandlerResult('rejected', msg);
    }
}
