import { describe, it, expect } from 'vitest';

import { CurePrefixScan, CureJoinKind } from './cure-prefix-scan';

const scan = new CurePrefixScan();

function kind(command: string): CureJoinKind {
    return scan.classify(command).kind;
}

function operator(command: string): string {
    return scan.classify(command).operator;
}

/**
 * The four command lines quoted in docs/audit/2026-08-24-mon-wed.md section 3 are the fixtures here.
 * They are what one agent actually typed while blocked on a `main` 15 commits behind, and they are the
 * reason this class exists: two of the four are safe by construction and were being refused anyway.
 */
describe('CurePrefixScan — the operator is the verdict', () => {
    it('reads `&&` as short-circuiting, so the work cannot run on a failed cure', () => {
        expect(kind('pnpm wp-checkout-clean-main && cat src/app.ts')).toBe('short-circuits');
        expect(kind('git pull --ff-only origin main && pnpm run build-all')).toBe('short-circuits');
        expect(kind("git fetch --prune origin main -q && git pull --ff-only origin main 2>&1 | tail -1 && sed -n '30,75p' x.ts"))
            .toBe('short-circuits');
    });

    it('reads `;`, `||`, `&` and a newline as running the work regardless', () => {
        expect(kind("pnpm wp-checkout-clean-main >/dev/null 2>&1; git log --oneline -1; sed -n '598,612p' e.mjs")).toBe('runs-anyway');
        expect(kind('git pull --ff-only origin main 2>&1 | tail -1; git log --oneline -3')).toBe('runs-anyway');
        expect(kind('git pull origin main || cat src/app.ts')).toBe('runs-anyway');
        expect(kind('git pull origin main\ncat src/app.ts')).toBe('runs-anyway');
    });

    it('reports the literal operator, because the fix is a one-character edit', () => {
        expect(operator('pnpm wp-checkout-clean-main; cat x.ts')).toBe(';');
        expect(operator('pnpm wp-checkout-clean-main || cat x.ts')).toBe('||');
        expect(operator('pnpm wp-checkout-clean-main && cat x.ts')).toBe('&&');
    });
});

describe('CurePrefixScan — what counts as the cure', () => {
    // The prefix may carry inert company. A `cd '<root>' &&` is how every guard renders a remedy that
    // must survive a reset cwd, and an agent bounds output by reflex — neither changes what runs.
    it('lets a leading cd, an echo and a piped filter ride along', () => {
        expect(kind("cd /repo && pnpm wp-checkout-clean-main >/dev/null 2>&1 && cat src/app.ts")).toBe('short-circuits');
        expect(kind('git pull origin main | tail -1 && cat src/app.ts')).toBe('short-circuits');
    });

    /*
     * A `git fetch` moves the remote-tracking ref and leaves local `main` exactly as far behind, so
     * `git fetch && <work>` short-circuits on nothing — the work still reads the stale tree. It may
     * LEAD the prefix, because `fetch && pull` is the shape agents type, but it never satisfies it.
     */
    it('does not accept a fetch alone as the cure, though it may lead one', () => {
        expect(kind('git fetch origin main && cat src/app.ts')).toBe('none');
        expect(kind('git fetch --prune origin main && git pull origin main && cat src/app.ts')).toBe('short-circuits');
    });

    /*
     * A pull of some OTHER branch merges it into `main`. That is a different and worse thing than
     * being stale, and it leaves local `main` still not containing `origin/main` — so the work behind
     * the `&&` would read the same stale tree the block is about. A pull with no refspec takes the
     * current branch's upstream, and the current branch is `main` wherever this class is consulted.
     */
    it('accepts a pull of main in every spelling, and no other branch', () => {
        expect(kind('git pull && cat x.ts')).toBe('short-circuits');
        expect(kind('git pull origin && cat x.ts')).toBe('short-circuits');
        expect(kind('git pull --ff-only origin main 2>&1 && cat x.ts')).toBe('short-circuits');
        expect(kind('git pull origin origin/main && cat x.ts')).toBe('short-circuits');
        expect(kind('git pull origin dean/some-feature && cat x.ts')).toBe('none');
    });

    it('is not opened by an allowlisted command that cures nothing', () => {
        expect(kind('pnpm install && cat src/app.ts')).toBe('none');
        expect(kind('pnpm wp-cleanup && cat src/app.ts')).toBe('none');
        expect(kind('git status --porcelain | head && cat src/app.ts')).toBe('none');
        expect(kind('gh pr view 1 && cat src/app.ts')).toBe('none');
    });

    /*
     * `>/dev/null` on the cure is an agent muting chatter, and under `&&` the exit code still governs.
     * A redirect to a REAL path is a WRITE, and a segment that writes the tree is not something to wave
     * a following command through on the strength of.
     */
    it('accepts a /dev/null redirect on the cure but not a redirect to a real path', () => {
        expect(kind('pnpm wp-checkout-clean-main >/dev/null 2>&1 && cat src/app.ts')).toBe('short-circuits');
        expect(kind('git pull origin main > src/app.ts && cat src/app.ts')).toBe('none');
    });

    it('reports `none` for a command that is nothing but cure — the skip list already owns that', () => {
        expect(kind('pnpm wp-checkout-clean-main')).toBe('none');
        expect(kind('git fetch origin main && git pull origin main')).toBe('none');
        expect(kind('')).toBe('none');
    });
});
