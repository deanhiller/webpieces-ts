import * as fs from 'fs';
import { collectProjectInfo } from '../packages/tooling/nx-webpieces-rules/src/lib/graph-metadata';
import { WorkspaceWiringFormat } from '../packages/tooling/nx-webpieces-rules/src/lib/runtime-wiring/workspace-format';
import { renderRuleFailForHuman, RuleFailError } from '@webpieces/rules-config';

class WiringSourcePolicy {
    declare maxLines: number;
}

/** Upstream verifies its unreleased format rule against an explicitly reviewed source-test policy. */
class WiringSourceCheck {
    async run(): Promise<void> {
        const policy = JSON.parse(fs.readFileSync('rules/wiring-source-policy.json', 'utf8')) as WiringSourcePolicy;
        if (!Number.isInteger(policy.maxLines) || policy.maxLines < 1)
            throw new RuleFailError('wiring-format', 'Source-test policy requires a positive maxLines.');
        new WorkspaceWiringFormat().assert(process.cwd(), await collectProjectInfo(), policy.maxLines);
    }
}

new WiringSourceCheck().run().catch((error: Error) => {
    console.error(error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message);
    process.exitCode = 1;
});
