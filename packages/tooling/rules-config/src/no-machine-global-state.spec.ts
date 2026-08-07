import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as rulesConfig from './index';

/**
 * There is EXACTLY ONE place webpieces writes state: `{repo}/.webpieces`.
 *
 * `MachineStateHome` / `StateHome` / `WEBPIECES_STATE_HOME` / `PrBodyStore` were the machine-global
 * escape from that, and they existed for one artifact — the gated squash-commit body, which
 * `wp-land-pr` had to find from a tree that had not rendered it. Since the PR DESCRIPTION became that
 * body (see `pr-body-is-merge-body.spec.ts`), GitHub holds it, `wp-land-pr` reads it with
 * `gh pr view --json body`, and the store is a cache of a fact the remote owns — one that can only be
 * missing, stale, or on the wrong computer.
 *
 * So they are DELETED, not deprecated, per CLAUDE.md § "NO webpieces surface is released
 * backwards-compatible". This spec is the thing that goes red — by name — if any of them comes back,
 * because the failure mode is not a compile error: a resurrected store would simply start writing
 * outside the repo again, silently. See `decisions/0005-the-pr-description-is-the-merge-body.md`.
 */
describe('there is no machine-global state root', () => {
    const removed = [
        'MachineStateHome',
        'machineStateHome',
        'StateHome',
        'WEBPIECES_STATE_HOME_ENV',
        'PrBodyStore',
        'PrBodyLocation',
        'PrBodyOrigin',
        'RepoSlug',
        'PRS_STATE_DIR',
        'MERGE_BODY_FILE',
        'PR_ORIGIN_FILE',
    ];

    it.each(removed)('does not export %s', (name: string): void => {
        expect((rulesConfig as unknown as Record<string, unknown>)[name]).toBeUndefined();
    });

    it('has no source file implementing one either', (): void => {
        expect(fs.existsSync(path.join(__dirname, 'machine-state-home.ts'))).toBe(false);
        expect(fs.existsSync(path.join(__dirname, 'pr-body-store.ts'))).toBe(false);
    });

    /**
     * The env var is the part a CONSUMER could still be setting, so it gets its own assertion: nothing
     * in this package may read it back into existence, under this name or any other.
     *
     * COMMENTS are exempt on purpose — `index.ts` names the retired symbols so the next reader learns
     * where they went, which is the "no doc teaches a removed API in reverse" half of the rule. What
     * must not come back is CODE, so only non-comment lines are scanned.
     *
     * Plain `process.env['HOME']` is NOT what this looks for: `subagent-provenance` and
     * `review-provenance` legitimately read it to locate Claude's own transcript directory under
     * `~/.claude/projects`, which is the harness's state and not webpieces'. The thing being kept dead
     * is a webpieces state root outside the repo.
     */
    it('reads no state-home environment override anywhere in the package', (): void => {
        const offenders = sourceFiles(__dirname)
            .filter((file: string): boolean => path.basename(file) !== 'no-machine-global-state.spec.ts')
            .filter((file: string): boolean => codeLines(file).some(
                (line: string): boolean => line.includes('STATE_HOME')));

        expect(offenders.map((f: string): string => path.basename(f))).toEqual([]);
    });
});

// Every .ts under the package's src, so a resurrected reader cannot hide in a new file.
function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sourceFiles(full));
        else if (entry.name.endsWith('.ts')) found.push(full);
    }
    return found;
}

// Lines that are not `//` or `*`/`/*` comment bodies. Crude on purpose: it only has to be right enough
// that a real `process.env[...]` read cannot hide behind a leading comment marker.
function codeLines(file: string): string[] {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line: string): boolean => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}
