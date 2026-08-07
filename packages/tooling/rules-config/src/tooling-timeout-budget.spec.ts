import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, type TestContext } from 'vitest';

/** The budget vitest.setup.mts grants every `packages/tooling/**` spec. Keep in step with that file. */
const TOOLING_TIMEOUT_MS = 120_000;

/**
 * Proves vitest.setup.mts actually grants `packages/tooling/**` its longer timeout budget.
 *
 * This earns a test because the mechanism fails SILENTLY. The setup file resolves
 * `expect.getState().testPath` to decide whether to raise the budget, and if that value ever comes back
 * empty — a vitest upgrade, a different pool, some other runner — it deliberately leaves the 45s global
 * in force rather than guessing. That is the safe direction to fail, and it is also invisible: the tooling
 * suites would quietly go back to timing out under parallel load, and the next person would re-diagnose a
 * file-level timeout that has already cost three separate investigations (publish-packages,
 * branch-creation-guard.e2e, and a checklist-scanner test in pr-gate, in three different packages).
 *
 * So this asserts the budget is really in effect, from inside the tree it covers, and fails by NAME
 * instead of resurfacing weeks later as a flake somewhere unrelated.
 *
 * `ctx.task.timeout` is the RESOLVED per-test budget — the value the runner will actually enforce, after
 * setupFiles have run. (`vi.getConfig` does not exist in vitest 4; this was verified by probe, not
 * assumed.) Deliberately not proven by sleeping past 45s: that would add a minute of dead wall-clock to
 * every run to observe a number we can read directly.
 */
describe('the packages/tooling timeout budget from vitest.setup.mts', () => {
    it('is in force for this file, which lives under packages/tooling', (ctx: TestContext) => {
        expect(ctx.task.timeout).toBe(TOOLING_TIMEOUT_MS);
    });

    // Guards the discriminator itself. An empty testPath is the one input that makes the setup file
    // no-op, so if this ever goes blank the budget above is not being granted by path at all — it would
    // only look right by accident.
    it('was selected by a testPath the setup file could actually see', () => {
        const testPath = expect.getState().testPath ?? '';
        expect(testPath).toContain('/packages/tooling/');
    });
});

/**
 * NO tooling spec may pass an explicit timeout argument, because doing so SILENTLY DEFEATS the budget.
 *
 * This is the regression test for the way the first cut of this change failed. A third argument on
 * `it()`/`beforeAll()` overrides `vi.setConfig` from a setup file, and
 * `branch-creation-guard.e2e.spec.ts` carried `}, 60_000)` on the exact hook that was timing out — so the
 * one file most in need of 120s was the only one still capped, at 60s, against a 46s idle measurement.
 * The commit that "fixed" the timeouts shipped with that file still broken and a comment claiming
 * otherwise, and the build went red again with the fix supposedly in place.
 *
 * Two spellings of one budget, where the narrower one wins and neither is visible from the other — which
 * is the shape the repo's compatibility policy rejects on API surfaces, showing up in test config.
 *
 * So: scan the source. An assertion about the RESOLVED timeout can only ever cover the file it runs in,
 * and the defeat happens in whichever file someone annotates next.
 *
 * It rejects a CORRECT number too (`}, 120_000)`), on purpose: a second spelling of the budget is the
 * problem regardless of what it currently says, because it stops tracking the setup file the moment that
 * changes. Known gap: a non-literal argument (`}, TIMEOUT)`) slips through. Closing that would mean
 * parsing rather than scanning, for a form nobody has written here — and the literal is what people
 * actually reach for, as all four removed offenders were.
 */
describe('no tooling spec narrows the budget with an explicit timeout argument', () => {
    it('finds no `}, <number>);` timeout override anywhere under packages/tooling', () => {
        const toolingRoot = path.resolve(__dirname, '..', '..');
        const offenders = specFilesUnder(toolingRoot)
            .flatMap((file: string): string[] => {
                const lines = fs.readFileSync(file, 'utf8').split('\n');
                return lines
                    .map((line: string, i: number): string =>
                        /^\s*\},\s*[0-9_]+\s*\);\s*$/.test(line)
                            ? `${path.relative(toolingRoot, file)}:${i + 1} ${line.trim()}`
                            : '')
                    .filter((hit: string): boolean => hit !== '');
            });
        expect(offenders).toEqual([]);
    });
});

// Every *.spec.ts under `dir`, skipping node_modules and build output.
function specFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...specFilesUnder(full));
        else if (entry.name.endsWith('.spec.ts')) out.push(full);
    }
    return out;
}
