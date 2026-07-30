import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateWebpiecesConfig, validatePrGateSection, validateSectionPlacement, validateCommandsSection, validateExcludePaths, validateMatchRulesSection, allRuleNames } from './validate-config';
import { HOOK_GUARD_NAMES } from './sections';
import { defaultRules } from './default-rules';

// A minimal valid match-rule entry, cloned + tweaked per test.
function validMatchRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: 'no-fetch',
        patterns: ['(?<![.\\w])fetch\\s*\\('],
        mainMessage: 'Use the generated client instead.',
        mode: 'NEW_AND_MODIFIED_CODE',
        turnOffRuleUntilEpoch: 0,
        turnOffRuleWhileOnBranch: null,
        ...overrides,
    };
}

// Helper: errors mentioning a given rule name.
function errorsFor(rule: string, errors: string[]): string[] {
    return errors.filter(e => e.includes(`[${rule}]`));
}

describe('validateWebpiecesConfig', () => {
    it('accepts excludePackages + escape hatches on no-file-import-cycles (regression)', () => {
        const errors = validateWebpiecesConfig({
            'no-file-import-cycles': {
                mode: 'RUN_EVERY_TIME',
                ignoreTypeOnly: false,
                excludePackages: ['@kami/entities'],
                turnOffRuleUntilEpoch: 1771931925,
                turnOffRuleWhileOnBranch: 'deanhiller/foo',
            },
        });
        // No field-level complaints for this rule (missing-OTHER-rule errors are expected and ignored).
        const fieldErrors = errorsFor('no-file-import-cycles', errors).filter(e => e.includes('Unknown field') || e.includes('must be'));
        expect(fieldErrors).toEqual([]);
    });

    it('still rejects a genuinely unknown field', () => {
        const errors = validateWebpiecesConfig({
            'no-file-import-cycles': { mode: 'RUN_EVERY_TIME', bogusField: true },
        });
        expect(errorsFor('no-file-import-cycles', errors).some(e => e.includes('Unknown field "bogusField"'))).toBe(true);
    });

    it('rejects an unknown rule key (e.g. a removed rule) when no rulesDir is configured', () => {
        const errors = validateWebpiecesConfig({ 'no-shell-substitution': { mode: 'OFF' } });
        expect(errors.some(e => e.includes('[no-shell-substitution]') && e.includes('Unknown rule'))).toBe(true);
    });

    it('leads the unknown-rule fix with `pnpm install` (version skew), not with deleting the key', () => {
        // The common cause is a stale install (config newer than the running validator). Deleting the
        // flagged key would gut valid config, so the message must point at `pnpm install` first.
        const [msg] = validateWebpiecesConfig({ 'brand-new-rule': { mode: 'ON' } });
        expect(msg).toContain('pnpm install');
        expect(msg.indexOf('pnpm install')).toBeLessThan(msg.indexOf('remove'));
    });

    it('allows an unknown rule key when a rulesDir is configured (may be a custom rule)', () => {
        const errors = validateWebpiecesConfig({ 'my-custom-rule': { mode: 'ON' } }, true);
        expect(errors.some(e => e.includes('[my-custom-rule]'))).toBe(false);
    });

    it('every rule accepts the universal escape hatches', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-or-push-guard': { mode: 'ON', turnOffRuleWhileOnBranch: 'x', turnOffRuleUntilEpoch: 1 },
            'pr-merge-guard': { mode: 'ON', turnOffRuleWhileOnBranch: 'x', turnOffRuleUntilEpoch: 1 },
            'feature-branch-guard': { mode: 'ON', turnOffRuleWhileOnBranch: 'x', turnOffRuleUntilEpoch: 1 },
        });
        for (const rule of ['pr-creation-or-push-guard', 'pr-merge-guard', 'feature-branch-guard']) {
            const fieldErrors = errorsFor(rule, errors).filter(e => e.includes('Unknown field'));
            expect(fieldErrors).toEqual([]);
        }
    });

    it('missing-rule snippet lists mode + BOTH escape hatches as required (always visible)', () => {
        // Omit no-file-import-cycles so the snippet is emitted for it.
        const errors = validateWebpiecesConfig({});
        const snippet = errors.find(e => e.includes('[no-file-import-cycles] Not configured'));
        expect(snippet).toBeDefined();
        expect(snippet!).toContain('"mode"');
        const [requiredBlock] = snippet!.split('Optional fields you may add');
        // Both hatches are REQUIRED now, so they land in the primary copy-paste block — the whole point
        // is that a seeded/edited rule always shows them. The old names must NOT appear at all.
        expect(requiredBlock).toContain('turnOffRuleUntilEpoch');
        expect(requiredBlock).toContain('turnOffRuleWhileOnBranch');
        expect(snippet!).not.toContain('ignoreModifiedUntilEpoch');
        expect(snippet!).not.toContain('ignoreRuleWhileOnBranch');
    });
});

describe('validateWebpiecesConfig — retired runtime-architecture fields', () => {
    it('rejects servicePaths + apiProjectPaths with a tailored "graph is auto-derived" hint', () => {
        // Both fields were removed from the schema — they were never read. A config that still enumerates
        // api libs must fail so the AI deletes the keys (not re-adds them, and not as a glob either).
        const errors = validateWebpiecesConfig({
            'runtime-architecture': {
                mode: 'RUN_EVERY_TIME',
                turnOffRuleUntilEpoch: 0,
                servicePaths: ['services/*/*'],
                apiProjectPaths: ['libraries/apis/internal/portal-apis', 'libraries/apis/internal/lang-apis'],
                allowedCycles: [],
            },
        });
        const ra = errorsFor('runtime-architecture', errors);
        const apiErr = ra.find(e => e.includes('Unknown field "apiProjectPaths"'));
        expect(apiErr).toBeDefined();
        expect(apiErr).toContain('derived automatically from architecture/dependencies.json');
        expect(ra.some(e => e.includes('Unknown field "servicePaths"'))).toBe(true);
    });
});

describe('validateWebpiecesConfig — standardized mode taxonomy', () => {
    // Structural rules (import-cycle / runtime-architecture / nx-wiring) use RUN_EVERY_TIME, not ON.
    it('accepts RUN_EVERY_TIME and rejects ON for structural rules', () => {
        for (const rule of ['no-file-import-cycles', 'runtime-architecture', 'nx-wiring']) {
            const ok = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: 0 },
            })).filter(e => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'ON', turnOffRuleUntilEpoch: 0 },
            }));
            expect(bad.some(e => e.includes('Must be one of') && e.includes('RUN_EVERY_TIME'))).toBe(true);
        }
    });

    // File-tier rules use NEW_AND_MODIFIED_FILES, not the old MODIFIED_FILES.
    it('accepts NEW_AND_MODIFIED_FILES and rejects MODIFIED_FILES for file-tier rules', () => {
        for (const rule of ['max-file-lines', 'validate-ts-in-src', 'no-js-files']) {
            const ok = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'NEW_AND_MODIFIED_FILES', turnOffRuleUntilEpoch: 0 },
            })).filter(e => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'MODIFIED_FILES', turnOffRuleUntilEpoch: 0 },
            }));
            expect(bad.some(e => e.includes('Must be one of') && e.includes('NEW_AND_MODIFIED_FILES'))).toBe(true);
        }
    });

    // Line-tier rules use NEW_AND_MODIFIED_CODE, not the old MODIFIED_CODE. The rename is a
    // deliberate breaking change: a downstream config still saying MODIFIED_CODE must hard-fail.
    it('accepts NEW_AND_MODIFIED_CODE and rejects the old MODIFIED_CODE for line-tier rules', () => {
        for (const rule of ['no-any-unknown', 'no-destructure', 'catch-error-pattern', 'no-symbol-di-tokens', 'throw-cause-required']) {
            const ok = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
            })).filter(e => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
            }));
            expect(bad.some(e => e.includes('Must be one of') && e.includes('NEW_AND_MODIFIED_CODE'))).toBe(true);
        }
    });

    // framework-tag is PROJECT-level: it uses MODIFIED_PROJECTS, not the line/file-scoped modes.
    it('accepts MODIFIED_PROJECTS and rejects NEW_AND_MODIFIED_CODE for framework-tag', () => {
        const ok = errorsFor('framework-tag', validateWebpiecesConfig({
            'framework-tag': { mode: 'MODIFIED_PROJECTS', turnOffRuleUntilEpoch: 0 },
        })).filter(e => e.includes('Must be one of'));
        expect(ok).toEqual([]);

        const bad = errorsFor('framework-tag', validateWebpiecesConfig({
            'framework-tag': { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
        }));
        expect(bad.some(e => e.includes('Must be one of') && e.includes('MODIFIED_PROJECTS'))).toBe(true);
    });

    it('recommends the gradual scoped mode in the missing-rule snippet (framework-tag → MODIFIED_PROJECTS)', () => {
        const snippet = validateWebpiecesConfig({}).find(e => e.includes('[framework-tag] Not configured'));
        expect(snippet).toBeDefined();
        expect(snippet!).toContain('💡 Recommended: start with "mode": "MODIFIED_PROJECTS"');
        expect(snippet!).toContain('rolls out gradually');
        // Structural rules (RUN_EVERY_TIME only) get no gradual recommendation.
        const structural = validateWebpiecesConfig({}).find(e => e.includes('[no-file-import-cycles] Not configured'));
        expect(structural!).not.toContain('💡 Recommended');
    });
});

describe('validateWebpiecesConfig — required fields + branch-creation-guard modes', () => {
    it('rejects a rule with mode only — BOTH escape hatches are now required', () => {
        const errors = errorsFor('pr-creation-or-push-guard', validateWebpiecesConfig({
            'pr-creation-or-push-guard': { mode: 'ON' },
        }));
        expect(errors.some(e => e.includes('Missing required field "turnOffRuleUntilEpoch"'))).toBe(true);
        expect(errors.some(e => e.includes('Missing required field "turnOffRuleWhileOnBranch"'))).toBe(true);
    });

    it('accepts the new turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch field names', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-or-push-guard': { mode: 'ON', turnOffRuleUntilEpoch: 1771931925, turnOffRuleWhileOnBranch: 'deanhiller/foo' },
        });
        expect(errorsFor('pr-creation-or-push-guard', errors)).toEqual([]);
    });

    it('rejects turnOffRuleUntilEpoch with the wrong type', () => {
        const errors = validateWebpiecesConfig({
            // webpieces-disable no-any-unknown -- deliberately wrong type for the negative test
            'pr-creation-or-push-guard': { mode: 'ON', turnOffRuleUntilEpoch: 'soon' as unknown as number },
        });
        expect(
            errorsFor('pr-creation-or-push-guard', errors).some(
                e => e.includes('"turnOffRuleUntilEpoch" must be number'),
            ),
        ).toBe(true);
    });

    it('rejects a present rule that is missing the required mode', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-or-push-guard': { turnOffRuleUntilEpoch: 0 },
        });
        expect(
            errorsFor('pr-creation-or-push-guard', errors).some(
                e => e.includes('Missing required field "mode"'),
            ),
        ).toBe(true);
    });

    it('accepts a fully-specified rule (mode + both hatches)', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-or-push-guard': { mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
        });
        expect(errorsFor('pr-creation-or-push-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard accepts ON_NO_SUBBRANCHES mode and branchFormat', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': {
                mode: 'ON_NO_SUBBRANCHES',
                branchFormat: 'Name it {whoami}/<feature>',
                subBranchNaming: 'feature/<ticket>/<desc>',
                autoReapMergedBranches: true,
                turnOffRuleUntilEpoch: 0,
                turnOffRuleWhileOnBranch: null,
            },
        });
        expect(errorsFor('branch-creation-guard', errors)).toEqual([]);
    });

});

describe('validateWebpiecesConfig — escape-hatch fields (required, nullable branch, renamed old names)', () => {
    it('accepts a null branch hatch (the always-on value)', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-or-push-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
        });
        expect(errorsFor('pr-creation-or-push-guard', errors)).toEqual([]);
    });

    it('flags the renamed old names with a "renamed to X" hint', () => {
        const errors = errorsFor('pr-creation-or-push-guard', validateWebpiecesConfig({
            // webpieces-disable no-any-unknown -- deliberately the removed old names for the negative test
            'pr-creation-or-push-guard': { mode: 'ON', ignoreModifiedUntilEpoch: 0, ignoreRuleWhileOnBranch: null } as unknown as Record<string, unknown>,
        }));
        expect(errors.some(e => e.includes('"ignoreModifiedUntilEpoch" — it was renamed to "turnOffRuleUntilEpoch"'))).toBe(true);
        expect(errors.some(e => e.includes('"ignoreRuleWhileOnBranch" — it was renamed to "turnOffRuleWhileOnBranch"'))).toBe(true);
    });
});

describe('validateWebpiecesConfig — autoReapMergedBranches must be explicit', () => {
    /**
     * autoReapMergedBranches lets the background refresher DELETE branches with nobody watching, so
     * it is required rather than defaulted: a project must say `true` or `false` out loud. A default
     * would mean branches vanishing on a preference the project never expressed — and the reader of
     * webpieces.config.json would have no way to tell whether that was intended.
     */
    it('branch-creation-guard requires an explicit autoReapMergedBranches — no silent default', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0 },
        });
        expect(
            errorsFor('branch-creation-guard', errors).some(
                e => e.includes('Missing required field "autoReapMergedBranches"'),
            ),
        ).toBe(true);
    });

    it('branch-creation-guard accepts autoReapMergedBranches false (report-only)', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': {
                mode: 'ON',
                autoReapMergedBranches: false,
                turnOffRuleUntilEpoch: 0,
                turnOffRuleWhileOnBranch: null,
            },
        });
        expect(errorsFor('branch-creation-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard rejects an invalid mode', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': { mode: 'SOMETIMES', turnOffRuleUntilEpoch: 0 },
        });
        expect(
            errorsFor('branch-creation-guard', errors).some(
                e => e.includes('"mode" = "SOMETIMES" is not valid'),
            ),
        ).toBe(true);
    });
});

describe('validatePrGateSection', () => {
    it('errors with a copy-paste example when the block is missing', () => {
        const errors = validatePrGateSection(undefined);
        expect(errors.some(e => e.includes('[pr-gate] Not configured'))).toBe(true);
        expect(errors.some(e => e.includes('"buildCommand"'))).toBe(true);
    });

    it('requires buildCommand when mode is ON', () => {
        const errors = validatePrGateSection({ mode: 'ON' });
        expect(errors.some(e => e.includes('Missing required field "buildCommand"'))).toBe(true);
    });

    it('does not require buildCommand when mode is OFF', () => {
        expect(validatePrGateSection({ mode: 'OFF' })).toEqual([]);
    });

    it('accepts a full valid block (warningColor + disabled example gate)', () => {
        const errors = validatePrGateSection({
            mode: 'ON',
            buildCommand: 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)',
            mergeMode: 'AUTO',
            gates: [
                { name: 'API', patterns: ['**/*Api.ts'], warningColor: 'yellow' },
                { name: 'DB Schema', patterns: ['**/schema.prisma'], warningColor: 'red', disabled: true },
            ],
        });
        expect(errors).toEqual([]);
    });

    it('rejects a gate missing the required warningColor', () => {
        const bad = validatePrGateSection({
            mode: 'ON', buildCommand: 'x',
            gates: [{ name: 'API', patterns: ['**/*Api.ts'] }],
        });
        expect(bad.some(e => e.includes('gates[0].warningColor is required'))).toBe(true);
    });

    it('rejects an invalid mode and malformed gates', () => {
        const bad = validatePrGateSection({ mode: 'MAYBE', buildCommand: 'x', gates: [{ patterns: 'nope' }] });
        expect(bad.some(e => e.includes('"mode" = "MAYBE" is not valid'))).toBe(true);
        expect(bad.some(e => e.includes('gates[0].name must be a string'))).toBe(true);
        expect(bad.some(e => e.includes('gates[0].patterns must be string[]'))).toBe(true);
    });

    it('rejects an invalid gate warningColor and a non-boolean disabled', () => {
        const bad = validatePrGateSection({
            mode: 'ON', buildCommand: 'x',
            gates: [{ name: 'X', patterns: ['**/*.ts'], warningColor: 'warn', disabled: 'nope' }],
        });
        expect(bad.some(e => e.includes('gates[0].warningColor must be "yellow" or "red"'))).toBe(true);
        expect(bad.some(e => e.includes('gates[0].disabled must be a boolean'))).toBe(true);
    });
});

// Split from the block above only because the combined describe() callback exceeded max-method-lines.
describe('validatePrGateSection — mergeMode (required policy)', () => {

    it('REQUIRES mergeMode — the policy is never guessed', () => {
        const bad = validatePrGateSection({ mode: 'ON', buildCommand: 'x' });
        expect(bad.some(e => e.includes('Missing required field "mergeMode"'))).toBe(true);
    });

    it('accepts every valid mergeMode', () => {
        for (const mergeMode of ['AUTO', 'NONE']) {
            expect(validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode })).toEqual([]);
        }
    });

    it('rejects an unknown mergeMode and explains what each mode costs', () => {
        const bad = validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode: 'DETECT' });
        expect(bad.some(e => e.includes('"mergeMode" = "DETECT" is not valid'))).toBe(true);
        expect(bad.some(e => e.includes('allow_auto_merge'))).toBe(true);
        expect(bad.some(e => e.includes('squash_merge_commit_title'))).toBe(true);
    });

    it('does NOT require mergeMode when the whole gate is OFF', () => {
        expect(validatePrGateSection({ mode: 'OFF' })).toEqual([]);
    });
});

describe('validateSectionPlacement', () => {
    it('flags a guard left in the rules section', () => {
        const errors = validateSectionPlacement({ 'pr-creation-or-push-guard': { mode: 'ON' } }, {});
        expect(errors.some(e => e.includes('[pr-creation-or-push-guard]') && e.includes('"hookGuards"'))).toBe(true);
    });

    it('flags a code rule placed in the hookGuards section', () => {
        const errors = validateSectionPlacement({}, { 'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE' } });
        expect(errors.some(e => e.includes('[no-any-unknown]') && e.includes('"rules"'))).toBe(true);
    });

    it('accepts correctly-placed entries', () => {
        const errors = validateSectionPlacement(
            { 'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE' } },
            { 'pr-creation-or-push-guard': { mode: 'ON' } },
        );
        expect(errors).toEqual([]);
    });

    it('ignores unknown/custom names in hookGuards', () => {
        const errors = validateSectionPlacement({}, { 'my-custom-guard': { mode: 'ON' } });
        expect(errors).toEqual([]);
    });
});

describe('validateCommandsSection', () => {
    it('errors on a deprecated top-level pr-gate block', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' } }, { mode: 'OFF' });
        expect(errors.some(e => e.includes('top-level "pr-gate" block is deprecated'))).toBe(true);
    });

    it('validates commands.pr-gate (missing → error)', () => {
        const errors = validateCommandsSection({}, undefined);
        expect(errors.some(e => e.includes('[pr-gate] Not configured'))).toBe(true);
    });

    it('accepts a valid commands section with string command overrides', () => {
        const errors = validateCommandsSection(
            { 'pr-gate': { mode: 'OFF' }, upsertPr: 'pnpm my-upsert-pr', mergeComplete: 'pnpm my-merge-complete' },
            undefined,
        );
        expect(errors).toEqual([]);
    });

    it('rejects a non-string command field', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, upsertPr: 123 }, undefined);
        expect(errors.some(e => e.includes('[commands] "upsertPr" must be a string'))).toBe(true);
    });

    it('accepts a commands.guardHints object with valid command strings', () => {
        const errors = validateCommandsSection(
            { 'pr-gate': { mode: 'OFF' }, guardHints: { prCreationOrPush: 'pnpm up', mergeInProgress: 'pnpm fin' } },
            undefined,
        );
        expect(errors).toEqual([]);
    });

    it('rejects an empty guardHints command string', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHints: { prCreationOrPush: '  ' } }, undefined);
        expect(errors.some(e => e.includes('[commands] "guardHints.prCreationOrPush" must be a non-empty string'))).toBe(true);
    });

    it('rejects guardHints that is not an object', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, guardHints: 'pnpm up' }, undefined);
        expect(errors.some(e => e.includes('[commands] "guardHints" must be an object'))).toBe(true);
    });
});

describe('validateExcludePaths', () => {
    it('errors with a copy-paste example when the block is missing (required)', () => {
        const errors = validateExcludePaths(undefined);
        expect(errors.some(e => e.includes('[excludePaths] Not configured'))).toBe(true);
        expect(errors.some(e => e.includes('"rules"') && e.includes('"guards"'))).toBe(true);
    });

    it('accepts a valid block with empty and populated lists', () => {
        expect(validateExcludePaths({ rules: [], guards: [] })).toEqual([]);
        expect(validateExcludePaths({ rules: ['repositories/**'], guards: ['vendor/**'] })).toEqual([]);
    });

    it('rejects a non-object (e.g. an array)', () => {
        expect(validateExcludePaths(['repositories/**']).some(e => e.includes('Must be an object'))).toBe(true);
    });

    it('rejects a missing or non-string-array rules/guards list', () => {
        expect(validateExcludePaths({ guards: [] }).some(e => e.includes('"rules" must be a string[]'))).toBe(true);
        expect(validateExcludePaths({ rules: [], guards: 'nope' }).some(e => e.includes('"guards" must be a string[]'))).toBe(true);
        expect(validateExcludePaths({ rules: [1, 2], guards: [] }).some(e => e.includes('"rules" must be a string[]'))).toBe(true);
    });
});

describe('validateMatchRulesSection', () => {
    it('errors when missing, printing the ready-to-paste no-fetch example', () => {
        const errors = validateMatchRulesSection(undefined);
        expect(errors.some(e => e.includes('[match-rules] Not configured'))).toBe(true);
        // The printed example seeds the no-fetch guard so a client can copy it in.
        expect(errors.some(e => e.includes('"match-rules"') && e.includes('"no-fetch"'))).toBe(true);
    });

    it('accepts an empty array (a conscious opt-out)', () => {
        expect(validateMatchRulesSection([])).toEqual([]);
    });

    it('accepts a fully-specified valid entry', () => {
        expect(validateMatchRulesSection([validMatchRule({ options: ['a', 'b'], allowedPaths: ['packages/**'], disableAllowed: true })])).toEqual([]);
    });

    it('rejects a non-array section', () => {
        expect(validateMatchRulesSection({ name: 'no-fetch' }).some(e => e.includes('Must be an array'))).toBe(true);
    });

    it('reports an invalid regex with the entry name and index', () => {
        const errors = validateMatchRulesSection([validMatchRule({ patterns: ['('] })]);
        expect(errors.some(e => e.includes('"no-fetch".patterns[0] is not a valid regex'))).toBe(true);
    });

    it('requires name, patterns, mainMessage, mode, and BOTH escape hatches', () => {
        const errors = validateMatchRulesSection([{ name: '' }]);
        expect(errors.some(e => e.includes('.name must be a non-empty string'))).toBe(true);
        expect(errors.some(e => e.includes('.patterns must be a non-empty string[]'))).toBe(true);
        expect(errors.some(e => e.includes('.mainMessage must be a non-empty string'))).toBe(true);
        expect(errors.some(e => e.includes('.mode must be one of'))).toBe(true);
        // Both hatches are required on match-rules too.
        expect(errors.some(e => e.includes('.turnOffRuleUntilEpoch must be a number'))).toBe(true);
        expect(errors.some(e => e.includes('.turnOffRuleWhileOnBranch must be a string or null'))).toBe(true);
    });

    it('validates the epoch hatch type when present', () => {
        // webpieces-disable no-any-unknown -- deliberately wrong type for the negative test
        const errors = validateMatchRulesSection([validMatchRule({ turnOffRuleUntilEpoch: 'soon' as unknown as number })]);
        expect(errors.some(e => e.includes('.turnOffRuleUntilEpoch must be a number'))).toBe(true);
    });

    it('accepts a null branch hatch and flags the renamed old names', () => {
        expect(validateMatchRulesSection([validMatchRule({ turnOffRuleUntilEpoch: 1771931925, turnOffRuleWhileOnBranch: 'deanhiller/foo' })])).toEqual([]);
        // webpieces-disable no-any-unknown -- deliberately the removed old name for the negative test
        const renamed = validateMatchRulesSection([validMatchRule({ ignoreModifiedUntilEpoch: 0 } as Record<string, unknown>)]);
        expect(renamed.some(e => e.includes('"ignoreModifiedUntilEpoch" — it was renamed to "turnOffRuleUntilEpoch"'))).toBe(true);
    });

    it('rejects an invalid mode value', () => {
        expect(validateMatchRulesSection([validMatchRule({ mode: 'ON' })]).some(e => e.includes('.mode must be one of'))).toBe(true);
    });

    it('flags duplicate entry names', () => {
        const errors = validateMatchRulesSection([validMatchRule(), validMatchRule()]);
        expect(errors.some(e => e.includes('duplicate entry name "no-fetch"'))).toBe(true);
    });
});

// Registry-consistency invariants. read-stale-guard (then named main-stale-guard) shipped in 0.4.415
// registered in HOOK_GUARD_NAMES
// (so the validator DEMANDED it in config) but absent from RULE_SCHEMAS (so the validator REJECTED it
// as an unknown rule) — a hard deadlock: config-without-it fails the sync check, config-with-it fails
// validation, and the only writes still allowed (config edits, pnpm install) can't reach the version
// pin. These tests lock the two name-lists together so a half-wired guard can never ship again.
describe('rule registry consistency', () => {
    it('every hook-guard name has a schema in RULE_SCHEMAS (else the validator demands a key it then rejects)', () => {
        const schema = new Set(allRuleNames());
        const missing = HOOK_GUARD_NAMES.filter((name: string): boolean => !schema.has(name));
        expect(missing).toEqual([]);
    });

    it('allRuleNames is exactly the schema keys, so the installer seeds every known rule', () => {
        // allRuleNames drives buildSeedConfig; a name missing here can never be seeded and a repo
        // could not add it via `wp-install-ai-hooks --sync`.
        expect(allRuleNames().length).toBeGreaterThan(0);
        expect(new Set(allRuleNames()).has('read-stale-guard')).toBe(true);
    });

    it('every defaultRules key has a schema (else the loader defaults a rule the validator rejects)', () => {
        const schema = new Set(allRuleNames());
        const missing = Object.keys(defaultRules).filter((name: string): boolean => !schema.has(name));
        expect(missing).toEqual([]);
    });

    // The five Nx infrastructure validators enforced unconditionally before they were wired to config.
    // Their default MUST stay RUN_EVERY_TIME so upgrading a repo never silently stops a CI gate.
    it('the Nx infrastructure validators default to RUN_EVERY_TIME (never silently disabled on upgrade)', () => {
        const infra = [
            'validate-architecture-unchanged', 'validate-no-architecture-cycles',
            'validate-packagejson', 'validate-versions-locked', 'validate-eslint-sync',
        ];
        for (const name of infra) {
            expect(new Set(allRuleNames()).has(name)).toBe(true);
            expect(defaultRules[name]?.['mode']).toBe('RUN_EVERY_TIME');
        }
    });
});

// webpieces-disable no-any-unknown -- a raw pr-gate section from a test
function validPrGate(checklists: unknown): Record<string, unknown> {
    return { mode: 'ON', buildCommand: 'pnpm ci', mergeMode: 'AUTO', gates: [], checklists };
}

// A temp repo root, optionally with `.claude/review/<doc>` files and `.claude/agents/<name>.md` reviewers.
function repoWith(docs: string[] = [], agents: string[] = []): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-checklists-'));
    fs.mkdirSync(path.join(dir, '.claude', 'review'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(dir, '.claude', 'review', d), '# doc');
    if (agents.length > 0) {
        fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
        for (const a of agents) fs.writeFileSync(path.join(dir, '.claude', 'agents', `${a}.md`), '# agent');
    }
    return dir;
}

describe('validatePrGateSection rejects gateSaltWhy', () => {
    it('tells the consumer to delete it, so the next validate on upgrade forces removal', () => {
        const section = { mode: 'ON', buildCommand: 'pnpm ci', mergeMode: 'AUTO', gateSalt: 's', gateSaltWhy: 'it works like this...' };
        const errors = validatePrGateSection(section);
        expect(errors.some((e: string): boolean => /DELETE the "gateSaltWhy" key/.test(e))).toBe(true);
    });

    it('leaves every other *Why rationale key alone', () => {
        const section = { mode: 'ON', buildCommand: 'pnpm ci', mergeMode: 'AUTO', buildCommandWhy: 'because', gatesWhy: 'because' };
        expect(validatePrGateSection(section)).toEqual([]);
    });
});

describe('validatePrGateSection checklists — the array in webpieces.config.json is the ONLY shape', () => {
    it('accepts a well-formed array with repo-relative docs', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { subagent: 'db-reviewer', doc: '.claude/review/db.md', patterns: ['**/*.sql'] },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('resolves item docs REPO-relative — a bare filename is not found', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([{ subagent: 'db-reviewer', doc: 'db.md' }]), dir);
        expect(errors.some((e: string): boolean => /\.doc "db\.md" does not exist/.test(e))).toBe(true);
    });

    it('rejects a non-object entry, a non-string doc, and non-string patterns', () => {
        expect(validatePrGateSection(validPrGate(['nope'])).some((e: string): boolean => /checklists\[0\] must be an object/.test(e))).toBe(true);
        expect(validatePrGateSection(validPrGate([{ subagent: 'r', doc: 7 }])).some((e: string): boolean => /checklists\[0\]\.doc must be a string/.test(e))).toBe(true);
        expect(validatePrGateSection(validPrGate([{ subagent: 'r', patterns: [1] }])).some((e: string): boolean => /checklists\[0\]\.patterns must be a string\[\]/.test(e))).toBe(true);
    });

    it('rejects a duplicate subagent', () => {
        const dir = repoWith([], ['r']);
        const errors = validatePrGateSection(validPrGate([{ subagent: 'r' }, { subagent: 'r' }]), dir);
        expect(errors.some((e: string): boolean => /duplicate subagent "r"/.test(e))).toBe(true);
    });

    it('rejects a subagent with no .claude/agents/<name>.md', () => {
        const dir = repoWith([], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([{ subagent: 'db-revewer' }]), dir);
        expect(errors.some((e: string): boolean => /names no reviewer/.test(e))).toBe(true);
    });

    it('leaves the reviewer-agent check off for a repo with no .claude/agents dir', () => {
        const dir = repoWith();
        expect(validatePrGateSection(validPrGate([{ subagent: 'nobody' }]), dir)).toEqual([]);
    });

    it('an empty array is valid — it means "no checklists"', () => {
        expect(validatePrGateSection(validPrGate([]), repoWith())).toEqual([]);
    });
});

/**
 * The `{ doc }` manifest shape is REMOVED, not deprecated. A consumer still on it must FAIL — loudly, with
 * the exact edit — rather than be quietly carried along by a compatibility branch. This is the whole point:
 * an AI applies the printed migration in one pass, so permanent duality buys nothing.
 */
describe('validatePrGateSection rejects the removed { doc } manifest shape', () => {
    const legacy = { doc: '.claude/review/index.md' };

    it('fails, and never silently accepts it', () => {
        expect(validatePrGateSection(validPrGate(legacy)).length).toBeGreaterThan(0);
    });

    it('names the doc the consumer pointed at, so they know which file holds the array to move', () => {
        const err = validatePrGateSection(validPrGate(legacy)).join('\n');
        expect(err).toContain('.claude/review/index.md');
        expect(err).toContain('REMOVED');
    });

    it('spells out the migration, including that entry docs become REPO-relative', () => {
        const err = validatePrGateSection(validPrGate(legacy)).join('\n');
        expect(err).toContain('webpieces:checklists');
        expect(err).toContain('REPO-relative');
        expect(err).toContain('"checklists": <that array>');
    });

    // Even with a repoRoot to inspect, there is no path that reads the manifest doc any more.
    it('fails identically when a repoRoot is available — nothing reads the doc now', () => {
        const dir = repoWith(['index.md']);
        expect(validatePrGateSection(validPrGate(legacy), dir).join('\n')).toContain('REMOVED');
    });

    it('still fails when doc is empty or the object is otherwise empty', () => {
        expect(validatePrGateSection(validPrGate({ doc: '' })).length).toBeGreaterThan(0);
    });
});

describe('validatePrGateSection rejects every non-array checklists value', () => {
    it('rejects a string, a number, and null with the array requirement + an example', () => {
        for (const bad of ['nope', 7, null]) {
            const errors = validatePrGateSection(validPrGate(bad));
            expect(errors.some((e: string): boolean => /"checklists" must be an ARRAY/.test(e))).toBe(true);
        }
    });
});
