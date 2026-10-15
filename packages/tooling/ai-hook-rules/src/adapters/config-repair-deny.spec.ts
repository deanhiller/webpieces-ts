import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import { RulePackRegistry, prepareLegacyUpgrade } from '@webpieces/rules-config';

import { runPipeline } from './hook-core';

const OWNER = '.webpieces-config/rules/fixture-0.json';

/** The rules hook's half of #1273: a config problem is a deny with its cure, and the cure's edit passes. */
class RulesHookRepo {
    readonly root = fs.realpathSync(specTempDirs.make('wp-rules-hook-repair-'));

    constructor() {
        // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
        const config = prepareLegacyUpgrade({}, new RulePackRegistry(policyFixture.manifests())).config as Record<string, any>;
        config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
        policyFixture.writeOwnerConfig(this.root, config);
    }

    /** One Write through the rules hook; the deny reason, or null for an allow. */
    write(file: string): string | null {
        const payload = JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 'sess-rules-repair',
            transcript_path: '/dev/null',
            cwd: this.root,
            tool_name: 'Write',
            tool_input: { file_path: file, content: 'export const a = 1;\n' },
        });
        const stdout = runPipeline(payload, 'rules').stdout.trim();
        if (stdout === '') return null;
        const parsed = JSON.parse(stdout);
        return parsed.hookSpecificOutput?.permissionDecision === 'deny'
            ? String(parsed.hookSpecificOutput.permissionDecisionReason)
            : null;
    }
}

describe('the rules hook renders a config problem as a structured deny and permits its cure (#1273)', () => {
    it('a missing required entry: deny naming the file and the entry, never a crash; the owner-file edit passes', () => {
        const repo = new RulesHookRepo();
        const owner = path.join(repo.root, OWNER);
        const entries = JSON.parse(fs.readFileSync(owner, 'utf8'));
        delete entries['max-file-lines'];
        fs.writeFileSync(owner, JSON.stringify(entries, null, 2));

        const deny = repo.write(path.join(repo.root, 'src/work.ts'));
        expect(deny).not.toBeNull();
        expect(deny).not.toContain('hook crashed unexpectedly');
        expect(deny).toContain(`${owner}: missing required entry "max-file-lines"`);
        expect(deny).toContain('"max-file-lines": {');
        expect(deny).toContain(`Fix Option 1: (preferred) Edit ${owner}`);

        expect(repo.write(owner)).toBeNull();
        expect(repo.write(path.join(repo.root, '.webpieces-config/rules/another.json'))).toBeNull();
        expect(repo.write(path.join(repo.root, 'webpieces.config.json'))).toBeNull();
    });
});
