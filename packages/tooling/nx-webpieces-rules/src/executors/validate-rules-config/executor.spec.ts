import { policyFixture } from '@webpieces/tooling-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';

import type { ExecutorContext } from '@nx/devkit';

import { describe, expect, it } from 'vitest';

import runExecutor from './executor';

class ConfigFixture {
    write(contents: string): string {
        const root = policyFixture.makeRepo('wp-rules-check-');
        fs.writeFileSync(path.join(root, 'webpieces.config.json'), contents);
        return root;
    }

    context(root: string): ExecutorContext {
        return { root } as ExecutorContext;
    }
}

const fixture = new ConfigFixture();

describe('rules:check config characterization', () => {
    it('fails malformed config edits at the scoped target', (): void => {
        expect(() => runExecutor({}, fixture.context(fixture.write('{ not json'))))
            .toThrow('could not be parsed as JSON');
    });

    it('fails when required rule entries are missing', (): void => {
        const root = fixture.write(JSON.stringify({
            rules: {},
            hookGuards: {},
            commands: { 'pr-gate': { mode: 'ON', buildCommand: 'echo ci', mergeMode: 'AUTO', reviewerAgents: 1, maxReviewerRounds: 2 } },
            excludePaths: [],
            'match-rules': [],
        }));
        expect(() => runExecutor({}, fixture.context(root)))
            .toThrow('Not configured in webpieces.config.json');
    });
});
