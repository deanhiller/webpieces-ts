import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CLAUDE_CONFIG_DIR_ENV, ClaudeConfigDir, claudeConfigDir } from './claude-config-dir';

const savedHome = process.env['HOME'];
const savedConfigDir = process.env[CLAUDE_CONFIG_DIR_ENV];

beforeEach(() => {
    delete process.env[CLAUDE_CONFIG_DIR_ENV];
});

afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    if (savedConfigDir === undefined) delete process.env[CLAUDE_CONFIG_DIR_ENV];
    else process.env[CLAUDE_CONFIG_DIR_ENV] = savedConfigDir;
});

describe('ClaudeConfigDir.root', () => {
    it('is ~/.claude when the variable is unset', () => {
        expect(claudeConfigDir.root()).toBe(path.join(os.homedir(), '.claude'));
        expect(claudeConfigDir.configuredDir()).toBe('');
    });

    it('is $CLAUDE_CONFIG_DIR when it is set', () => {
        process.env[CLAUDE_CONFIG_DIR_ENV] = '/somewhere/.claude-work';
        expect(claudeConfigDir.root()).toBe('/somewhere/.claude-work');
        expect(claudeConfigDir.projectsRoots()[0]).toBe(path.join('/somewhere/.claude-work', 'projects'));
    });

    // An exported-but-empty variable is the same state as an unset one: the harness falls back, so a
    // resolver that took it literally would search the filesystem ROOT's `projects` dir.
    it('falls back when the variable is set to an empty (or blank) string', () => {
        process.env[CLAUDE_CONFIG_DIR_ENV] = '   ';
        expect(claudeConfigDir.root()).toBe(path.join(os.homedir(), '.claude'));
    });
});

describe('ClaudeConfigDir.roots — the both-roots probe', () => {
    // The exported instance and a freshly constructed one answer identically — nothing is cached, so a
    // test (or a wp-* bin) that sets the variable after import still gets the right answer.
    it('holds no cached state: a fresh instance agrees with the process-wide one', () => {
        process.env[CLAUDE_CONFIG_DIR_ENV] = '/somewhere/else';
        expect(new ClaudeConfigDir().roots()).toEqual(claudeConfigDir.roots());
    });

    it('is one root when the variable is unset', () => {
        expect(claudeConfigDir.roots()).toEqual([path.join(os.homedir(), '.claude')]);
    });

    // The configured root comes FIRST, so the tree this process was told about wins a tie.
    it('is the configured root then ~/.claude when they differ', () => {
        process.env[CLAUDE_CONFIG_DIR_ENV] = '/somewhere/.claude-work';
        expect(claudeConfigDir.roots()).toEqual(['/somewhere/.claude-work', path.join(os.homedir(), '.claude')]);
        expect(claudeConfigDir.projectsRoots()).toEqual([
            path.join('/somewhere/.claude-work', 'projects'),
            path.join(os.homedir(), '.claude', 'projects'),
        ]);
    });

    // …and never the same directory twice, however it was spelled.
    it('collapses to one root when the variable names ~/.claude itself', () => {
        process.env[CLAUDE_CONFIG_DIR_ENV] = path.join(os.homedir(), '.claude', '.', '');
        expect(claudeConfigDir.roots()).toHaveLength(1);
    });
});

/**
 * The regression guard issue #963 asked for.
 *
 * The bug was not that one module got the resolution wrong in an interesting way — it was that THREE
 * modules each resolved it themselves and only one was right, so the fix is worthless unless the second
 * copy cannot come back. A `'.claude'` literal in any of these files IS that second copy.
 *
 * Asserted over the SOURCE text on purpose, which is the one place that is legitimate: the defect is
 * literally "somebody wrote the path inline again", and there is no runtime behaviour to observe until
 * the machine under test happens to relocate its config dir — which is exactly the machine nobody runs
 * the suite on.
 */
describe('no module re-derives the config dir for itself', () => {
    const files = ['subagent-provenance.ts', 'review-provenance.ts', 'harness-agent-activity.ts'];

    it.each(files)('%s names no hardcoded .claude path', (file: string) => {
        const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
        const code = source.split('\n')
            .filter((line: string): boolean => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
            .join('\n');
        expect(code).not.toContain(`'.claude'`);
        expect(code).not.toContain(CLAUDE_CONFIG_DIR_ENV);
    });

    // Pins the detector in the other direction, so it cannot rot into decoration: the resolver itself
    // holds both spellings, and the assertion above must be capable of seeing them.
    it('would catch the literal — the resolver, which is allowed to hold it, trips both checks', () => {
        const source = fs.readFileSync(path.join(__dirname, 'claude-config-dir.ts'), 'utf8');
        expect(source).toContain(`'.claude'`);
        expect(source).toContain(CLAUDE_CONFIG_DIR_ENV);
    });
});
