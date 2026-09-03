import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import {
    ADD_HOOK_PKG_CMD, HOOK_PKG,
    L0AllowEntry, L0_ALLOWLIST, SHIM_LOG_FIELDS, SHIM_LOG_VERDICTS, ShimLogField, ShimLogVerdict,
    isAllowed,
} from '../bin/shim';
import { GUARDS_BIN, RULES_BIN, HARNESS_REGISTRATIONS, HarnessRegistration } from '../bin/hook-registration';
import { L0FaultCode, L0_FAULT_NAMES } from './l0-fault-codes';
import { L0Cure, L0Fault, L0_FAULTS } from './l0-matrix';
import { L0ToolingDoc, L0_DOC_BEGIN, L0_DOC_END } from './l0-tooling-doc';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const L0_DOC = path.join(REPO_ROOT, 'guards', 'L0-tooling.md');
const doc = (): string => fs.readFileSync(L0_DOC, 'utf8');

/**
 * Commands the doc quotes that L0 deliberately does NOT accept — every one of them named IN the doc as
 * something you cannot or must not run while blocked. An EXPLICIT list, because the point of the
 * assertion below is that anything NOT on it is a cure a reader may copy: a new denied command in a Fix
 * position fails here instead of teaching an unreachable cure.
 *
 *   pnpm wp-start-update / wp-start-upsert-pr  the 3-point merge — the drift row says NOT to run it
 *                                              while the block is up, and it does not need to be allowed
 *   pnpm guards:generate                       the maintenance command for this file, run on a healthy tree
 *   git merge                                  deliberately absent from the allowlist; the doc says so
 *   git worktree                               quoted as the DENIED bare spelling, next to the one
 *                                              subcommand (`list`) that is accepted
 *   git pull / git pull origin main /          the BARE pull spellings, off the list since audit finding
 *     git checkout feat && git pull origin main  C6 — quoted precisely as the ones that are refused,
 *                                              beside `git checkout main && git pull origin main`, which
 *                                              IS on the list and is therefore NOT exempt here
 */
const QUOTED_BUT_NOT_A_CURE: readonly string[] = [
    'pnpm wp-start-update',
    'pnpm wp-start-upsert-pr',
    'pnpm guards:generate',
    'git merge',
    'git worktree',
    'git pull',
    'git pull origin main',
    'git checkout feat && git pull origin main',
];

/**
 * Every backticked literal in `text` that reads as a shell command. The trailing `\s+\S` matters:
 * without it `pnpm-lock.yaml` and a bare `cp` in prose read as commands.
 */
function quotedCommands(text: string): readonly string[] {
    const literals = [...text.matchAll(/`([^`\n]+)`/g)].map((m: RegExpMatchArray): string => m[1]);
    return literals.filter((l: string): boolean => /^(?:pwd$|(?:pnpm|npm|npx|cp|rm|git)\s+\S)/.test(l))
        .filter((l: string): boolean => !QUOTED_BUT_NOT_A_CURE.includes(l));
}

/**
 * THE BYTE LOCK, exactly as l1-matrix.spec.ts locks guards/L1-location.md and l0-matrix.spec.ts locks
 * webpieces.guard-matrix.md — with the one difference that makes this doc's case different: only the
 * marked BLOCK is generated, because the rest of the file is incident history and argument that a
 * renderer would mangle.
 *
 * This doc is the one that has actually gone stale. It described FOUR managed surfaces after there were
 * three, and a 7-field audit line after `shim=`/`bin=`/`layer=`/`row=` had joined it — a doc L0's own
 * deny messages point a blocked agent at.
 */
describe('guards/L0-tooling.md — the generated block IS the arrays', () => {
    it('matches L0ToolingDoc.render() byte for byte', () => {
        expect(new L0ToolingDoc().extract(doc()), 'run `pnpm guards:generate` to regenerate the block')
            .toBe(new L0ToolingDoc().render());
    });

    it('carries exactly one marker pair, and splicing it is idempotent', () => {
        const committed = doc();
        expect(committed.split(L0_DOC_BEGIN)).toHaveLength(2);
        expect(committed.split(L0_DOC_END)).toHaveLength(2);
        expect(new L0ToolingDoc().splice(committed)).toBe(committed);
    });

    // A doc that quietly stopped being spliced would drift with nothing to say so — which is the whole
    // failure mode this file is here to end. So the extractor REFUSES an unmarked or doubly-marked doc.
    it('refuses a doc with no markers, or with two of them', () => {
        const tool = new L0ToolingDoc();
        expect((): string => tool.extract('# no markers here\n')).toThrow(/exactly one BEGIN\/END marker pair/);
        expect((): string => tool.extract(`${L0_DOC_BEGIN}\nx\n${L0_DOC_END}\n${L0_DOC_BEGIN}\ny\n${L0_DOC_END}`))
            .toThrow(/exactly one BEGIN\/END marker pair/);
    });

    it('preserves every byte of the hand-written prose around it', () => {
        const committed = doc();
        const rewritten = new L0ToolingDoc().splice(committed.replace(
            new L0ToolingDoc().extract(committed), 'STALE CONTENT'));
        expect(rewritten).toBe(committed);
    });
});

/** The block must actually CARRY every coordinate, not merely be locked to whatever it says today. */
describe('the generated block renders every array it claims to render', () => {
    it('names every fault, its guard name and every one of its cures', () => {
        const block = new L0ToolingDoc().render();
        for (const fault of L0_FAULTS) {
            expect(block, `fault ${fault.code}`).toContain(`\`${fault.code}\``);
            expect(block, `guard name for ${fault.code}`).toContain(L0_FAULT_NAMES[fault.code as L0FaultCode]);
            for (const cure of fault.cures) {
                expect(block, `cure literal: ${cure.mention}`).toContain(cure.mention);
                expect(block, `discriminator for: ${cure.mention}`).toContain(cure.discriminator);
            }
        }
    });

    it('lists every allowlist entry, in order, with its outcome', () => {
        const block = new L0ToolingDoc().render();
        L0_ALLOWLIST.forEach((entry: L0AllowEntry, i: number): void => {
            expect(block, `entry ${String(i + 1)}`).toContain(`| ${String(i + 1)} | ${entry.label.split('|').join('\\|')} | ${entry.kind.toUpperCase()} |`);
        });
    });

    it('renders every audit-line field and every verdict label', () => {
        const block = new L0ToolingDoc().render();
        for (const field of SHIM_LOG_FIELDS) {
            expect(block, `field ${field.label}`).toContain(field.means);
        }
        for (const verdict of SHIM_LOG_VERDICTS) {
            expect(block, `verdict ${verdict.label}`).toContain(`\`${verdict.label}\``);
        }
        // The optional field is rendered as optional — `bin=` in brackets — or the shape lies about a
        // line that is 10 fields wide most of the time.
        const optional = SHIM_LOG_FIELDS.filter((f: ShimLogField): boolean => f.optional);
        expect(optional).toHaveLength(1);
        expect(block).toContain(`[${optional[0].label}]`);
    });

    /**
     * The registrations are RENDERED from each harness's own shimCommand(), which is what makes "the hooks are ABSOLUTE"
     * a fact the doc cannot get wrong. It got it wrong twice while it was prose.
     */
    it('prints the two hook registrations from the code that installs them', () => {
        const block = new L0ToolingDoc().render();
        for (const harness of HARNESS_REGISTRATIONS) {
            expect(block, harness.label).toContain(harness.shimCommand(GUARDS_BIN));
            expect(block, harness.label).toContain(harness.shimCommand(RULES_BIN));
        }
        expect(block).toContain('$CLAUDE_PROJECT_DIR');
    });
});

/**
 * CURE REACHABILITY, over the WHOLE doc rather than only the generated block.
 *
 * The L0 allowlist matches whole command strings, so a command a blocked reader can copy out of this
 * file and cannot then run is worse than no command at all — that is the deadlock shape CLAUDE.md
 * records three times. The generated block gets this by construction (it renders from the cures); the
 * hand-written half gets it from this assertion.
 */
describe('every command the doc quotes is runnable while L0 is blocking', () => {
    it('accepts every backticked command in the generated block', () => {
        for (const command of quotedCommands(new L0ToolingDoc().render())) {
            expect(isAllowed('Bash', command, '', 'claude-code'), `the block prescribes a DENIED command: ${command}`).not.toBeNull();
        }
    });

    it('accepts every backticked command in the hand-written prose too', () => {
        const prose = doc().split(L0_DOC_BEGIN)[0] + doc().split(L0_DOC_END)[1];
        for (const command of quotedCommands(prose)) {
            expect(isAllowed('Bash', command, '', 'claude-code'), `the prose quotes a DENIED command: ${command}`).not.toBeNull();
        }
    });

    // The cures the FAULTS carry must be exactly the cures the doc prints — not a paraphrase of them.
    it('prints each cure verbatim, so a reader copies the string isAllowed() judged', () => {
        const block = new L0ToolingDoc().render();
        for (const cure of L0_FAULTS.flatMap((f: L0Fault): readonly L0Cure[] => f.cures)) {
            if (!cure.isCommand()) continue;
            expect(block).toContain(`\`${cure.call.command}\``);
        }
    });
});

/**
 * NO SECOND SPELLING. The hand-written half must not grow its own copy of a generated table — that is
 * precisely how this file went stale, twice: a fault table and an allowlist table that nothing updated.
 */
describe('the hand-written half does not restate the generated tables', () => {
    const prose = (): string => doc().split(L0_DOC_BEGIN)[0] + doc().split(L0_DOC_END)[1];

    it('carries no second fault table and no second verdict table', () => {
        for (const fault of L0_FAULTS) {
            expect(prose(), `fault ${fault.code} row outside the block`).not.toContain(`| \`${fault.code}\` | `);
        }
        for (const verdict of SHIM_LOG_VERDICTS) {
            expect(prose(), `verdict ${verdict.label} row outside the block`)
                .not.toContain(`| \`${verdict.label}\` |`);
        }
    });

    it('carries no second allowlist table', () => {
        for (const entry of L0_ALLOWLIST) {
            expect(prose(), `allowlist row outside the block: ${entry.label}`)
                .not.toContain(`| ${entry.label.split('|').join('\\|')} |`);
        }
    });

    /**
     * The two claims that were FALSE in the shipped file and that no test could see: a RELATIVE
     * registration, and FOUR managed surfaces. Both are now rendered from code inside the block, so the
     * only way they can come back is as hand-written prose — which is what this asserts against.
     */
    it('never re-asserts the retired relative registration or a fourth managed surface', () => {
        expect(prose()).not.toMatch(/registered RELATIVE/i);
        expect(prose()).not.toMatch(/sh "\.claude\/webpieces/);
        expect(prose()).not.toMatch(/FOUR managed/i);
    });

    /**
     * THE HAND-WRITTEN HALF IS THE HALF THAT DRIFTS, and fault U's cure is the one where drifting is
     * expensive. Declaring the package directly is a SESSION UNBLOCK: a direct root dependency on it
     * violates the umbrella rule, so it must be reverted before committing. When the deny said
     * "(preferred)" and named no revert, it was followed exactly as written and reached a real
     * package.json — and the row below `<!-- END GENERATED -->` was still teaching that same spelling
     * after the generated half had been fixed, because `pnpm guards:generate` cannot reach down there.
     *
     * So: the prose may mention the add, but never WITHOUT the two things that make it safe to read.
     * Stated as a conditional rather than a ban because the row legitimately needs to describe the
     * cure's standing — what it must not do is describe it as a fix.
     */
    it('never teaches the fault-U add without its revert and the rule that demotes it', () => {
        if (!prose().includes(ADD_HOOK_PKG_CMD)) return;
        expect(prose(), `prose names '${ADD_HOOK_PKG_CMD}' but not its revert`)
            .toContain(`pnpm remove ${HOOK_PKG}`);
        expect(prose(), 'prose names the add but not the umbrella rule that makes it uncommittable')
            .toMatch(/umbrella rule/i);
    });

    /**
     * The two fault-U claims that were left FALSE in the hand-written half after the generated half was
     * corrected — the exact drift `pnpm guards:generate` cannot repair, because this prose sits below
     * `<!-- END GENERATED -->`. The first quotes a symptom string the shim no longer emits; the second
     * bans `pnpm install` outright, which now contradicts U's own Option 1 and Option 2 (a BARE install
     * is the no-op — change something first, then install).
     */
    it('never re-asserts the retired fault-U symptom or an unconditional ban on installing', () => {
        expect(prose()).not.toContain('is NOT declared in package.json anywhere');
        expect(prose()).not.toMatch(/do NOT run `pnpm install` again/i);
    });
});

/** The verdict/field arrays this doc renders must stay non-empty and self-describing. */
describe('the arrays the block renders are usable as documentation', () => {
    it('gives every field and every verdict a meaning', () => {
        for (const field of SHIM_LOG_FIELDS) expect(field.means.length, field.label).toBeGreaterThan(0);
        for (const verdict of SHIM_LOG_VERDICTS as readonly ShimLogVerdict[]) {
            expect(verdict.means.length, verdict.label).toBeGreaterThan(0);
        }
    });
});
