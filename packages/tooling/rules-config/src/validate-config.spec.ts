import { policyFixture } from '@webpieces/tooling-testkit';
import { RulePackRegistry } from '@webpieces/rules-config';
const fixtureRuleRegistry = new RulePackRegistry(policyFixture.manifests());
import {
    fixtureHookGuardNames as HOOK_GUARD_NAMES,
    fixtureTuning as defaultRules,
} from '@webpieces/tooling-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import {
    validateWebpiecesConfig,
    validatePrGateSection,
    validateMatchRulesSection,
    allRuleNames,
    recommendedSeedMode,
    recommendedSeedModeFor,
    seedEntryForRule,
} from './validate-config';

import { MODIFIED_CODE_MODES } from '@webpieces/rules-sdk';

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
    return errors.filter((e) => e.includes(`[${rule}]`));
}

describe('validateWebpiecesConfig', () => {
    it('names the declared owner file and direct policy map for an absent policy', () => {
        const errors = validateWebpiecesConfig({}, fixtureRuleRegistry);
        const advice = errorsFor('max-file-lines', errors).join('\n');
        expect(advice).toContain(fixtureRuleRegistry.ownerOf('max-file-lines'));
        expect(advice).toContain('declared owner config file');
        expect(advice).toContain('policy-ID map');
        expect(advice).not.toContain('webpieces.config.json');
        expect(advice).not.toContain('"rules" section');
        expect(advice).not.toContain('"hookGuards" section');
    });

    it('accepts excludePackages + escape hatches on no-file-import-cycles (regression)', () => {
        const errors = validateWebpiecesConfig(
            {
                'no-file-import-cycles': {
                    mode: 'RUN_EVERY_TIME',
                    ignoreTypeOnly: false,
                    excludePackages: ['@db/entities'],
                    turnOffRuleUntilEpoch: 1771931925,
                    turnOffRuleWhileOnBranch: 'deanhiller/foo',
                },
            },
            fixtureRuleRegistry,
        );
        // No field-level complaints for this rule (missing-OTHER-rule errors are expected and ignored).
        const fieldErrors = errorsFor('no-file-import-cycles', errors).filter(
            (e) => e.includes('Unknown field') || e.includes('must be'),
        );
        expect(fieldErrors).toEqual([]);
    });

    it('still rejects a genuinely unknown field', () => {
        const errors = validateWebpiecesConfig(
            {
                'no-file-import-cycles': { mode: 'RUN_EVERY_TIME', bogusField: true },
            },
            fixtureRuleRegistry,
        );
        expect(
            errorsFor('no-file-import-cycles', errors).some((e) =>
                e.includes('Unknown field "bogusField"'),
            ),
        ).toBe(true);
    });

    it('rejects an unknown rule key (e.g. a removed rule) when no rulesDir is configured', () => {
        const errors = validateWebpiecesConfig(
            { 'no-shell-substitution': { mode: 'OFF' } },
            fixtureRuleRegistry,
        );
        expect(
            errors.some((e) => e.includes('[no-shell-substitution]') && e.includes('Unknown rule')),
        ).toBe(true);
    });

    /**
     * INVERTED, deliberately. This used to assert the message led with `pnpm install` and only mentioned
     * removal as a last resort. Two things were wrong with that. The install advice CONTRADICTED the
     * banner the error is printed inside ("Do NOT run `pnpm install` — it cannot help"), and the premise
     * is handled upstream anyway: the shim's version-drift guard denies every tool call before this
     * validator is exec'd, so reaching this message proves the pin and node_modules already agree.
     * See config-pruner.spec.ts for the full case-by-case pinning.
     */
    it('leads the unknown-rule fix with DELETING the key, and never prescribes `pnpm install`', () => {
        const [msg] = validateWebpiecesConfig(
            { 'brand-new-rule': { mode: 'ON' } },
            fixtureRuleRegistry,
        );
        expect(msg).not.toContain('pnpm install');
        expect(msg).toContain('DELETE the "brand-new-rule" key');
        expect(msg).toContain('direct policy-ID map in its declared owner config file');
        expect(msg).not.toContain('key from webpieces.config.json');
        expect(msg.indexOf('DELETE')).toBeLessThan(msg.indexOf('Secondary'));
    });

    it('rejects an undeclared client rule instead of accepting a directory escape', () => {
        const errors = validateWebpiecesConfig(
            { 'my-custom-rule': { mode: 'ON' } },
            fixtureRuleRegistry,
        );
        expect(errors.some((e) => e.includes('[my-custom-rule]'))).toBe(true);
    });

    it('every rule accepts the universal escape hatches', () => {
        const errors = validateWebpiecesConfig(
            {
                'pr-lifecycle-guard': {
                    mode: 'ON',
                    turnOffRuleWhileOnBranch: 'x',
                    turnOffRuleUntilEpoch: 1,
                },
                'branch-creation-guard': {
                    mode: 'ON',
                    turnOffRuleWhileOnBranch: 'x',
                    turnOffRuleUntilEpoch: 1,
                },
                'branch-state-guard': {
                    mode: 'ON',
                    turnOffRuleWhileOnBranch: 'x',
                    turnOffRuleUntilEpoch: 1,
                },
            },
            fixtureRuleRegistry,
        );
        for (const rule of ['pr-lifecycle-guard', 'branch-creation-guard', 'branch-state-guard']) {
            const fieldErrors = errorsFor(rule, errors).filter((e) => e.includes('Unknown field'));
            expect(fieldErrors).toEqual([]);
        }
    });

    it('missing-rule snippet lists mode + BOTH escape hatches as required (always visible)', () => {
        // Omit no-file-import-cycles so the snippet is emitted for it.
        const errors = validateWebpiecesConfig({}, fixtureRuleRegistry);
        const snippet = errors.find((e) => e.includes('[no-file-import-cycles] Not configured'));
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
        const errors = validateWebpiecesConfig(
            {
                'runtime-architecture': {
                    mode: 'RUN_EVERY_TIME',
                    turnOffRuleUntilEpoch: 0,
                    servicePaths: ['services/*/*'],
                    apiProjectPaths: [
                        'libraries/apis/internal/portal-apis',
                        'libraries/apis/internal/lang-apis',
                    ],
                },
            },
            fixtureRuleRegistry,
        );
        const ra = errorsFor('runtime-architecture', errors);
        const apiErr = ra.find((e) => e.includes('Unknown field "apiProjectPaths"'));
        expect(apiErr).toBeDefined();
        expect(apiErr).toContain('derived automatically from architecture/dependencies.json');
        expect(ra.some((e) => e.includes('Unknown field "servicePaths"'))).toBe(true);
    });

    it('rejects allowedCycles — a runtime cycle is not allowable at all any more', () => {
        // The allowlist was the last shape saying "some cycles are fine". Levelling now throws on any
        // cycle, so a config still carrying the key would be configuring a code path that is gone. The
        // per-EDGE `cutLegacyCycle:<targetService>` nx tag replaced it, and it is not config at all.
        const errors = validateWebpiecesConfig(
            {
                'runtime-architecture': { mode: 'RUN_EVERY_TIME', allowedCycles: [] },
            },
            fixtureRuleRegistry,
        );
        const err = errorsFor('runtime-architecture', errors).find((e) =>
            e.includes('Unknown field "allowedCycles"'),
        );
        expect(err).toBeDefined();
        // The generic unknown-field error says WHAT vanished, not why — which is how an AI re-adds it.
        // The retired-field hint has to name the destination: the tag, and that there is no config key.
        expect(err).toContain('cutLegacyCycle:<targetService>');
        expect(err).toContain('there is no config key for it');
    });
});

describe('validateWebpiecesConfig — standardized mode taxonomy', () => {
    // Structural rules (import-cycle / runtime-architecture / nx-wiring) use RUN_EVERY_TIME, not ON.
    it('accepts RUN_EVERY_TIME and rejects ON for structural rules', () => {
        for (const rule of ['no-file-import-cycles', 'runtime-architecture', 'nx-wiring']) {
            const ok = errorsFor(
                rule,
                validateWebpiecesConfig(
                    {
                        [rule]: { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: 0 },
                    },
                    fixtureRuleRegistry,
                ),
            ).filter((e) => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(
                rule,
                validateWebpiecesConfig(
                    {
                        [rule]: { mode: 'ON', turnOffRuleUntilEpoch: 0 },
                    },
                    fixtureRuleRegistry,
                ),
            );
            expect(
                bad.some((e) => e.includes('Must be one of') && e.includes('RUN_EVERY_TIME')),
            ).toBe(true);
        }
    });

    // File-tier rules use NEW_AND_MODIFIED_FILES, not the old MODIFIED_FILES.
    it('accepts NEW_AND_MODIFIED_FILES and rejects MODIFIED_FILES for file-tier rules', () => {
        for (const rule of ['max-file-lines', 'validate-ts-in-src', 'no-js-files']) {
            const ok = errorsFor(
                rule,
                validateWebpiecesConfig(
                    {
                        [rule]: { mode: 'NEW_AND_MODIFIED_FILES', turnOffRuleUntilEpoch: 0 },
                    },
                    fixtureRuleRegistry,
                ),
            ).filter((e) => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(
                rule,
                validateWebpiecesConfig(
                    {
                        [rule]: { mode: 'MODIFIED_FILES', turnOffRuleUntilEpoch: 0 },
                    },
                    fixtureRuleRegistry,
                ),
            );
            expect(
                bad.some(
                    (e) => e.includes('Must be one of') && e.includes('NEW_AND_MODIFIED_FILES'),
                ),
            ).toBe(true);
        }
    });

    // Line-tier rules use NEW_AND_MODIFIED_CODE, not the old MODIFIED_CODE. The rename is a
    // deliberate breaking change: a downstream config still saying MODIFIED_CODE must hard-fail.
    it('accepts NEW_AND_MODIFIED_CODE and rejects the old MODIFIED_CODE for line-tier rules', () => {
        for (const rule of [
            'no-any-unknown',
            'no-destructure',
            'catch-error-pattern',
            'no-symbol-di-tokens',
            'throw-cause-required',
        ]) {
            const ok = errorsFor(
                rule,
                validateWebpiecesConfig(
                    {
                        [rule]: { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
                    },
                    fixtureRuleRegistry,
                ),
            ).filter((e) => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(
                rule,
                validateWebpiecesConfig(
                    {
                        [rule]: { mode: 'MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
                    },
                    fixtureRuleRegistry,
                ),
            );
            expect(
                bad.some(
                    (e) => e.includes('Must be one of') && e.includes('NEW_AND_MODIFIED_CODE'),
                ),
            ).toBe(true);
        }
    });

    // framework-tag is PROJECT-level: it uses MODIFIED_PROJECTS, not the line/file-scoped modes.
    it('accepts MODIFIED_PROJECTS and rejects NEW_AND_MODIFIED_CODE for framework-tag', () => {
        const ok = errorsFor(
            'framework-tag',
            validateWebpiecesConfig(
                {
                    'framework-tag': { mode: 'MODIFIED_PROJECTS', turnOffRuleUntilEpoch: 0 },
                },
                fixtureRuleRegistry,
            ),
        ).filter((e) => e.includes('Must be one of'));
        expect(ok).toEqual([]);

        const bad = errorsFor(
            'framework-tag',
            validateWebpiecesConfig(
                {
                    'framework-tag': { mode: 'NEW_AND_MODIFIED_CODE', turnOffRuleUntilEpoch: 0 },
                },
                fixtureRuleRegistry,
            ),
        );
        expect(
            bad.some((e) => e.includes('Must be one of') && e.includes('MODIFIED_PROJECTS')),
        ).toBe(true);
    });

    it('seeds ensure-we-are-secure with direct-project scope and universal turn-offs', () => {
        expect(seedEntryForRule('ensure-we-are-secure', fixtureRuleRegistry)).toEqual({
            mode: 'MODIFIED_PROJECTS',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
        });
        const errors = errorsFor(
            'ensure-we-are-secure',
            validateWebpiecesConfig(
                {
                    'ensure-we-are-secure': {
                        mode: 'NEW_AND_MODIFIED_CODE',
                        turnOffRuleUntilEpoch: 0,
                        turnOffRuleWhileOnBranch: null,
                    },
                },
                fixtureRuleRegistry,
            ),
        );
        expect(errors.some((e) => e.includes('MODIFIED_PROJECTS'))).toBe(true);
    });

    it('recommends the gradual scoped mode in the missing-rule snippet (framework-tag → MODIFIED_PROJECTS)', () => {
        const snippet = validateWebpiecesConfig({}, fixtureRuleRegistry).find((e) =>
            e.includes('[framework-tag] Not configured'),
        );
        expect(snippet).toBeDefined();
        expect(snippet!).toContain('💡 Recommended: start with "mode": "MODIFIED_PROJECTS"');
        expect(snippet!).toContain('rolls out gradually');
        // Structural rules (RUN_EVERY_TIME only) get no gradual recommendation.
        const structural = validateWebpiecesConfig({}, fixtureRuleRegistry).find((e) =>
            e.includes('[no-file-import-cycles] Not configured'),
        );
        expect(structural!).not.toContain('💡 Recommended');
    });
});

describe('validateWebpiecesConfig — required fields + branch-creation-guard modes', () => {
    it('rejects a rule with mode only — BOTH escape hatches are now required', () => {
        const errors = errorsFor(
            'pr-lifecycle-guard',
            validateWebpiecesConfig(
                {
                    'pr-lifecycle-guard': { mode: 'ON' },
                },
                fixtureRuleRegistry,
            ),
        );
        expect(
            errors.some((e) => e.includes('Missing required field "turnOffRuleUntilEpoch"')),
        ).toBe(true);
        expect(
            errors.some((e) => e.includes('Missing required field "turnOffRuleWhileOnBranch"')),
        ).toBe(true);
    });

    it('accepts the new turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch field names', () => {
        const errors = validateWebpiecesConfig(
            {
                'pr-lifecycle-guard': {
                    mode: 'ON',
                    turnOffRuleUntilEpoch: 1771931925,
                    turnOffRuleWhileOnBranch: 'deanhiller/foo',
                },
            },
            fixtureRuleRegistry,
        );
        expect(errorsFor('pr-lifecycle-guard', errors)).toEqual([]);
    });

    it('rejects turnOffRuleUntilEpoch with the wrong type', () => {
        const errors = validateWebpiecesConfig(
            {
                // webpieces-disable no-any-unknown -- deliberately wrong type for the negative test
                'pr-lifecycle-guard': {
                    mode: 'ON',
                    turnOffRuleUntilEpoch: 'soon' as unknown as number,
                },
            },
            fixtureRuleRegistry,
        );
        expect(
            errorsFor('pr-lifecycle-guard', errors).some((e) =>
                e.includes('"turnOffRuleUntilEpoch" must be number'),
            ),
        ).toBe(true);
    });

    it('rejects a present rule that is missing the required mode', () => {
        const errors = validateWebpiecesConfig(
            {
                'pr-lifecycle-guard': { turnOffRuleUntilEpoch: 0 },
            },
            fixtureRuleRegistry,
        );
        expect(
            errorsFor('pr-lifecycle-guard', errors).some((e) =>
                e.includes('Missing required field "mode"'),
            ),
        ).toBe(true);
    });

    it('accepts a fully-specified rule (mode + both hatches)', () => {
        const errors = validateWebpiecesConfig(
            {
                'pr-lifecycle-guard': {
                    mode: 'OFF',
                    turnOffRuleUntilEpoch: 0,
                    turnOffRuleWhileOnBranch: null,
                },
            },
            fixtureRuleRegistry,
        );
        expect(errorsFor('pr-lifecycle-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard accepts ON_NO_SUBBRANCHES mode and branchFormat', () => {
        const errors = validateWebpiecesConfig(
            {
                'branch-creation-guard': {
                    mode: 'ON_NO_SUBBRANCHES',
                    branchFormat: 'Name it {whoami}/<feature>',
                    subBranchNaming: 'feature/<ticket>/<desc>',
                    autoReapMergedBranches: true,
                    turnOffRuleUntilEpoch: 0,
                    turnOffRuleWhileOnBranch: null,
                },
            },
            fixtureRuleRegistry,
        );
        expect(errorsFor('branch-creation-guard', errors)).toEqual([]);
    });
});

describe('validateWebpiecesConfig — escape-hatch fields (required, nullable branch, renamed old names)', () => {
    it('accepts a null branch hatch (the always-on value)', () => {
        const errors = validateWebpiecesConfig(
            {
                'pr-lifecycle-guard': {
                    mode: 'ON',
                    turnOffRuleUntilEpoch: 0,
                    turnOffRuleWhileOnBranch: null,
                },
            },
            fixtureRuleRegistry,
        );
        expect(errorsFor('pr-lifecycle-guard', errors)).toEqual([]);
    });

    it('flags the renamed old names with a "renamed to X" hint', () => {
        const errors = errorsFor(
            'pr-lifecycle-guard',
            validateWebpiecesConfig(
                {
                    // webpieces-disable no-any-unknown -- deliberately the removed old names for the negative test
                    'pr-lifecycle-guard': {
                        mode: 'ON',
                        ignoreModifiedUntilEpoch: 0,
                        ignoreRuleWhileOnBranch: null,
                    } as unknown as Record<string, unknown>,
                },
                fixtureRuleRegistry,
            ),
        );
        expect(
            errors.some((e) =>
                e.includes(
                    '"ignoreModifiedUntilEpoch" — it was renamed to "turnOffRuleUntilEpoch"',
                ),
            ),
        ).toBe(true);
        expect(
            errors.some((e) =>
                e.includes(
                    '"ignoreRuleWhileOnBranch" — it was renamed to "turnOffRuleWhileOnBranch"',
                ),
            ),
        ).toBe(true);
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
        const errors = validateWebpiecesConfig(
            {
                'branch-creation-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0 },
            },
            fixtureRuleRegistry,
        );
        expect(
            errorsFor('branch-creation-guard', errors).some((e) =>
                e.includes('Missing required field "autoReapMergedBranches"'),
            ),
        ).toBe(true);
    });

    it('branch-creation-guard accepts autoReapMergedBranches false (report-only)', () => {
        const errors = validateWebpiecesConfig(
            {
                'branch-creation-guard': {
                    mode: 'ON',
                    autoReapMergedBranches: false,
                    subBranchNaming: 'feature/<t>/<d>',
                    turnOffRuleUntilEpoch: 0,
                    turnOffRuleWhileOnBranch: null,
                },
            },
            fixtureRuleRegistry,
        );
        expect(errorsFor('branch-creation-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard rejects an invalid mode', () => {
        const errors = validateWebpiecesConfig(
            {
                'branch-creation-guard': { mode: 'SOMETIMES', turnOffRuleUntilEpoch: 0 },
            },
            fixtureRuleRegistry,
        );
        expect(
            errorsFor('branch-creation-guard', errors).some((e) =>
                e.includes('"mode" = "SOMETIMES" is not valid'),
            ),
        ).toBe(true);
    });
});
