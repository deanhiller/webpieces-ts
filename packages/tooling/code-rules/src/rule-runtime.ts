import 'reflect-metadata';
import { Container } from 'inversify';
import {
    BuildPolicy,
    BuildRuleRuntime,
    PolicyRuntimeRequest,
    BuildDebugRequest,
    BuildDebugRuntime,
    BuildPolicyResult,
} from '@webpieces/rules-sdk';
import { InformAiError } from '@webpieces/tooling-common';
import { CODE_POLICIES, CodePolicy } from './code-policy-registry';
import { WorkspaceRoot } from './code-rules-context';
import { ScanRestriction } from './scan-scope';
import { BuildPolicySet } from './code-rules-engine';

import { CodeRuleRuntime } from './code-policy-composition';

export const buildRuleRuntime = new CodeRuleRuntime();

/** Debug behavior remains owner-defined, including project restrictions and warning site counts. */
class CodeDebugRuntime implements BuildDebugRuntime {
    async run(request: BuildDebugRequest): Promise<BuildPolicyResult> {
        const bootstrap = await import('./code-rules-bootstrap');
        const parser = await import('./code-rules-run-request');
        const selection = request.selection;
        return new bootstrap.CodeRulesBootstrap().run(
            request.workspaceRoot,
            new parser.RunRequestParser().parse(selection.rule, selection.mode, selection.projects),
        );
    }
}

export const buildDebugRuntime = new CodeDebugRuntime();
