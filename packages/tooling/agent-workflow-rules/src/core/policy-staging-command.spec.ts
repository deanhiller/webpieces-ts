import { describe, it, expect } from 'vitest';

import { PolicyStagingCommand } from './policy-staging-command';

const scan = new PolicyStagingCommand();

describe('PolicyStagingCommand — the plain git add the untracked-policy refusal permits (#1327)', () => {
    it('accepts every plain git add spelling, with an optional leading literal cd', () => {
        for (const command of [
            'git add .webpieces-config/rules/local.json',
            'git add -- .webpieces-config/rules/local.json webpieces.config.json',
            'git add -A',
            'git add .',
            "git add -- '.webpieces-config/rules/my local.json'",
            'cd /repo && git add .webpieces-config',
            'git add a && git add b',
        ])
            expect(scan.isPlainGitAdd(command), command).toBe(true);
    });

    it('refuses anything that can do more than stage', () => {
        for (const command of [
            '',
            'git status',
            'git commit -am x',
            'git add a && rm -rf src',
            'git add a; git commit -m x',
            'git add a | sh',
            'git add a &',
            'git add $(rm -rf src)',
            'git add "$(rm -rf src)"',
            'git add `rm -rf src`',
            'git add a > out.txt',
            'GIT_DIR=/elsewhere git add a',
            'sudo git add a',
            'git -C /elsewhere add a',
            'cd /repo',
            'git add a && cd /repo',
            'git addx a',
        ])
            expect(scan.isPlainGitAdd(command), command).toBe(false);
    });
});
