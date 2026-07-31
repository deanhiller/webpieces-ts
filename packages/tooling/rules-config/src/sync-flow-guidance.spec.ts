import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { SyncFlowGuidance } from './sync-flow-guidance';

const guidance = new SyncFlowGuidance();

describe('SyncFlowGuidance — the canonical text', () => {
    it('always shows BOTH pairs, correctly paired', () => {
        const text = guidance.flows().join('\n');
        expect(text).toContain('pnpm wp-start-update');
        expect(text).toContain('pnpm wp-finish-update');
        expect(text).toContain('pnpm wp-start-upsert-pr');
        expect(text).toContain('pnpm wp-finish-upsert-pr');
        expect(text).toContain('wp-start-update    → wp-finish-update');
        expect(text).toContain('wp-start-upsert-pr → wp-finish-upsert-pr');
    });

    it('states that an open PR FORCES the upsert-pr pair, and why', () => {
        const text = guidance.whyPrForcesFlowB().join('\n');
        expect(text).toContain('MUST use the upsert-pr pair');
        expect(text).toContain('REWRITES this branch');
        expect(text).toContain('re-pointed');
    });

    it('never suggests running the update-only flow inside the PR-only block', () => {
        expect(guidance.prFlow().join('\n')).not.toContain('pnpm wp-start-update');
        expect(guidance.whyPrForcesFlowB().join('\n')).not.toContain('pnpm wp-start-update');
    });

    it('pairs finish commands back to their start', () => {
        expect(guidance.pairedStart('wp-finish-update')).toBe('wp-start-update');
        expect(guidance.pairedStart('wp-finish-upsert-pr')).toBe('wp-start-upsert-pr');
        // Unknown input is echoed, never guessed into one of the two.
        expect(guidance.pairedStart('wp-something-else')).toBe('wp-something-else');
    });

    it('offers read-only checks and says --ff-only is not one of them', () => {
        const text = guidance.readOnlyChecks().join('\n');
        expect(text).toContain('git merge-base --is-ancestor origin/main HEAD');
        expect(text).toContain('git rev-list --left-right --count origin/main...HEAD');
        expect(text).toContain('`git merge --ff-only` is NOT a look');
    });
});

// The drift this whole file exists to stop: messages and docs inventing command names that no bin
// answers to (`wp-update-start`, `wp-git-update`), which sends an AI chasing a command that errors.
/**
 * Drop whole markdown links — `[text](target)` — before scanning a line for command names.
 *
 * A link is a reference to a DOCUMENT, never a command invocation, and backlog filenames legitimately begin
 * with a command name (`bug-wp-start-upsert-pr-checklist-message-…`). Tokenizing those produced a bogus
 * "command" like `wp-start-upsert-pr-checklist-message-gives-the-ai-unresolvable-doc-paths` — a false
 * positive on a filename. Both the link TEXT and its TARGET are stripped, because a cross-reference commonly
 * repeats the filename in both. Commands in prose are written bare or in backticks, so they still get scanned.
 */
// webpieces-disable no-function-outside-class -- spec-local text helper, matches this file's style
function stripDocLinks(line: string): string {
    return line.replace(/\[[^\]]*\]\([^)]*\)/g, '');
}

// The bins are the source of truth — read them out of pr-gate's package.json, then scan every tracked
// .ts/.md for `wp-`-prefixed commands that are not among them.
describe('no doc or message names a wp-* command that does not exist', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

    function knownStartFinishBins(): Set<string> {
        const pkg = path.join(repoRoot, 'packages/tooling/pr-gate/package.json');
        // webpieces-disable no-any-unknown -- package.json shape is narrowed on the next line
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { bin?: Record<string, string> };
        const bins = Object.keys(parsed.bin ?? {})
            .filter((b: string): boolean => b.startsWith('wp-start-') || b.startsWith('wp-finish-'));
        // If this ever drops below the four flow bins, the scan below has stopped protecting anything.
        expect(bins.sort()).toEqual([
            'wp-finish-update', 'wp-finish-upsert-pr', 'wp-start-update', 'wp-start-upsert-pr',
        ]);
        return new Set(bins);
    }

    it('every wp-start-*/wp-finish-* token in tracked .ts/.md files is a real bin', () => {
        const known = knownStartFinishBins();
        const files = execFileSync('git', ['ls-files', '*.ts', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
            .split('\n')
            .filter((f: string): boolean => f !== '' && !f.endsWith('sync-flow-guidance.spec.ts'));

        const bad: string[] = [];
        for (const file of files) {
            const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
            lines.forEach((line: string, i: number): void => {
                // Also catch the inverted/legacy shapes that have actually been typed into docs before:
                // `wp-update-start`, `wp-upsert-pr-start`, `wp-git-update`.
                const matches = stripDocLinks(line).match(/\bwp-(?:start|finish)-[a-z0-9-]+|\bwp-(?:update|upsert-pr|git-update)\b(?:-start|-finish)?/g) ?? [];
                for (const token of matches) {
                    if (!known.has(token)) bad.push(`${file}:${i + 1}  ${token}`);
                }
            });
        }
        expect(bad).toEqual([]);
    });

    // `wp-review-upsert-pr` is the command every review instruction points AT, so a doc that misspells it
    // sends the AI to a bin that does not exist — the same failure this describe() block exists to prevent,
    // for a command the flow-bin regex above does not cover.
    it('every wp-review* token in tracked .ts/.md files is exactly the real bin', () => {
        expect(prGateBins(repoRoot)).toContain('wp-review-upsert-pr');
        // A trailing hyphen means it is a PREFIX, not a command (e.g. a mkdtempSync temp-dir prefix).
        expect(offendingTokens(repoRoot, /\bwp-review[a-z0-9-]*/g, 'wp-review-upsert-pr')).toEqual([]);
    });

    // `wp-checklist` was RENAMED to `wp-review-upsert-pr` — the bin is GONE, so any surviving mention sends
    // the AI to a command that no longer exists. This guard is what makes the rename stay done: it turns
    // "I think I got them all" into a failing test that names each one.
    it('no tracked .ts/.md file still mentions the removed wp-checklist bin', () => {
        expect(prGateBins(repoRoot)).not.toContain('wp-checklist');
        expect(offendingTokens(repoRoot, /\bwp-checklist[a-z0-9-]*/g, '')).toEqual([]);
    });

});

/**
 * The sibling defect to the one above: the command EXISTS, but the text tells you to run it in a form
 * you cannot type. None of the `wp-*` bins is a repo `package.json` script — every one resolves out of
 * `node_modules/.bin`, so `pnpm <bin>` is the ONLY runnable spelling. An instruction that says
 * "run `wp-cleanup`" hands an agent a command that dies with "command not found".
 *
 * Deliberately narrow: it fires only on an imperative verb IMMEDIATELY followed by a bin name
 * ("run wp-x", "re-run `wp-x`", "call wp-x"). Prose that merely NAMES a command — "`wp-cleanup` spares
 * worktree-held branches", "PAIRS with wp-start-update", doc comments, spec titles — is not an
 * instruction and stays bare on purpose.
 */
describe('every wp-* command an instruction hands out is runnable as typed', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

    it('no instruction tells you to run a wp-* bin without its `pnpm` prefix', () => {
        const bins = allWpBins(repoRoot);
        expect(bins).toContain('wp-land-pr');
        expect(bareRunInstructions(repoRoot, bins)).toEqual([]);
    });
});

/**
 * EVERY `wp-*` bin this monorepo ships, across all three publishing packages — the source of truth for
 * "is this token a real command someone is being told to run?".
 */
// webpieces-disable no-function-outside-class -- test helper, beside the specs that use it
function allWpBins(repoRoot: string): Set<string> {
    const pkgs = [
        'packages/tooling/pr-gate/package.json',
        'packages/tooling/code-rules/package.json',
        'packages/tooling/ai-hook-rules/package.json',
        'packages/tooling/nx-webpieces-rules/package.json',
    ];
    const bins = new Set<string>();
    for (const rel of pkgs) {
        // webpieces-disable no-any-unknown -- package.json shape is narrowed on the next line
        const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as { bin?: Record<string, string> };
        for (const name of Object.keys(parsed.bin ?? {})) bins.add(name);
    }
    return bins;
}

/** Every `<file>:<line>  <phrase>` where an imperative verb hands out a bare (un-`pnpm`'d) bin name. */
// webpieces-disable no-function-outside-class -- test helper, beside the specs that use it
function bareRunInstructions(repoRoot: string, bins: Set<string>): string[] {
    const verb = /\b(?:re-)?(?:run|call)\s+`?(wp-[a-z0-9-]+)/gi;
    const files = execFileSync('git', ['ls-files', '*.ts', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter((f: string): boolean => f !== '' && !f.endsWith('sync-flow-guidance.spec.ts'));
    const bad: string[] = [];
    for (const file of files) {
        const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
        lines.forEach((line: string, i: number): void => {
            for (const match of stripDocLinks(line).matchAll(verb)) {
                if (bins.has(match[1])) bad.push(`${file}:${i + 1}  ${match[0].trim()}`);
            }
        });
    }
    return bad;
}

// webpieces-disable no-function-outside-class -- test helper, beside the specs that use it
function prGateBins(repoRoot: string): string[] {
    const pkg = path.join(repoRoot, 'packages/tooling/pr-gate/package.json');
    // webpieces-disable no-any-unknown -- package.json shape is narrowed on the next line
    const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { bin?: Record<string, string> };
    return Object.keys(parsed.bin ?? {});
}

/**
 * Every `<file>:<line>  <token>` where `pattern` matched something that is not `allowed`. Pass '' for
 * `allowed` to ban the whole prefix. This spec file is skipped — it necessarily names the tokens it bans.
 */
// webpieces-disable no-function-outside-class -- test helper, beside the specs that use it
function offendingTokens(repoRoot: string, pattern: RegExp, allowed: string): string[] {
    const files = execFileSync('git', ['ls-files', '*.ts', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter((f: string): boolean => f !== '' && !f.endsWith('sync-flow-guidance.spec.ts'));
    const bad: string[] = [];
    for (const file of files) {
        const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
        lines.forEach((line: string, i: number): void => {
            for (const token of stripDocLinks(line).match(pattern) ?? []) {
                // A trailing hyphen means it is a PREFIX, not a command — e.g. a mkdtempSync dir prefix.
                if (token !== allowed && !token.endsWith('-')) bad.push(`${file}:${i + 1}  ${token}`);
            }
        });
    }
    return bad;
}
