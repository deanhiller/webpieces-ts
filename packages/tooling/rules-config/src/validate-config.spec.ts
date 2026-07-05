import { validateWebpiecesConfig, validatePrGateSection, validateSectionPlacement, validateCommandsSection, validateExcludePaths, validateMatchRulesSection } from './validate-config';

// A minimal valid match-rule entry, cloned + tweaked per test.
function validMatchRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: 'no-fetch',
        patterns: ['(?<![.\\w])fetch\\s*\\('],
        mainMessage: 'Use the generated client instead.',
        mode: 'NEW_AND_MODIFIED_CODE',
        ignoreModifiedUntilEpoch: 0,
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
                ignoreModifiedUntilEpoch: 1771931925,
                ignoreRuleWhileOnBranch: 'deanhiller/foo',
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

    it('allows an unknown rule key when a rulesDir is configured (may be a custom rule)', () => {
        const errors = validateWebpiecesConfig({ 'my-custom-rule': { mode: 'ON' } }, true);
        expect(errors.some(e => e.includes('[my-custom-rule]'))).toBe(false);
    });

    it('every rule accepts the universal escape hatches', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-guard': { mode: 'ON', ignoreRuleWhileOnBranch: 'x', ignoreModifiedUntilEpoch: 1 },
            'pr-merge-guard': { mode: 'ON', ignoreRuleWhileOnBranch: 'x', ignoreModifiedUntilEpoch: 1 },
            'feature-branch-guard': { mode: 'ON', ignoreRuleWhileOnBranch: 'x', ignoreModifiedUntilEpoch: 1 },
        });
        for (const rule of ['pr-creation-guard', 'pr-merge-guard', 'feature-branch-guard']) {
            const fieldErrors = errorsFor(rule, errors).filter(e => e.includes('Unknown field'));
            expect(fieldErrors).toEqual([]);
        }
    });

    it('missing-rule snippet lists mode + ignoreModifiedUntilEpoch as required, ignoreRuleWhileOnBranch as optional', () => {
        // Omit no-file-import-cycles so the snippet is emitted for it.
        const errors = validateWebpiecesConfig({});
        const snippet = errors.find(e => e.includes('[no-file-import-cycles] Not configured'));
        expect(snippet).toBeDefined();
        // Required block contains mode...
        expect(snippet!).toContain('"mode"');
        const [requiredBlock, optionalBlock] = snippet!.split('Optional fields you may add');
        expect(optionalBlock).toBeDefined();
        // ignoreModifiedUntilEpoch is now REQUIRED — it appears in the required copy-paste entry.
        expect(requiredBlock).toContain('ignoreModifiedUntilEpoch');
        expect(optionalBlock).not.toContain('ignoreModifiedUntilEpoch');
        // ignoreRuleWhileOnBranch stays optional.
        expect(requiredBlock).not.toContain('ignoreRuleWhileOnBranch');
        expect(optionalBlock).toContain('ignoreRuleWhileOnBranch');
    });
});

describe('validateWebpiecesConfig — standardized mode taxonomy', () => {
    // Structural rules (import-cycle / runtime-architecture / nx-wiring) use RUN_EVERY_TIME, not ON.
    it('accepts RUN_EVERY_TIME and rejects ON for structural rules', () => {
        for (const rule of ['no-file-import-cycles', 'runtime-architecture', 'nx-wiring']) {
            const ok = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'RUN_EVERY_TIME', ignoreModifiedUntilEpoch: 0 },
            })).filter(e => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'ON', ignoreModifiedUntilEpoch: 0 },
            }));
            expect(bad.some(e => e.includes('Must be one of') && e.includes('RUN_EVERY_TIME'))).toBe(true);
        }
    });

    // File-tier rules use NEW_AND_MODIFIED_FILES, not the old MODIFIED_FILES.
    it('accepts NEW_AND_MODIFIED_FILES and rejects MODIFIED_FILES for file-tier rules', () => {
        for (const rule of ['max-file-lines', 'validate-ts-in-src', 'no-js-files']) {
            const ok = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'NEW_AND_MODIFIED_FILES', ignoreModifiedUntilEpoch: 0 },
            })).filter(e => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'MODIFIED_FILES', ignoreModifiedUntilEpoch: 0 },
            }));
            expect(bad.some(e => e.includes('Must be one of') && e.includes('NEW_AND_MODIFIED_FILES'))).toBe(true);
        }
    });

    // Line-tier rules use NEW_AND_MODIFIED_CODE, not the old MODIFIED_CODE. The rename is a
    // deliberate breaking change: a downstream config still saying MODIFIED_CODE must hard-fail.
    it('accepts NEW_AND_MODIFIED_CODE and rejects the old MODIFIED_CODE for line-tier rules', () => {
        for (const rule of ['no-any-unknown', 'no-destructure', 'catch-error-pattern', 'no-symbol-di-tokens', 'throw-cause-required']) {
            const ok = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'NEW_AND_MODIFIED_CODE', ignoreModifiedUntilEpoch: 0 },
            })).filter(e => e.includes('Must be one of'));
            expect(ok).toEqual([]);

            const bad = errorsFor(rule, validateWebpiecesConfig({
                [rule]: { mode: 'MODIFIED_CODE', ignoreModifiedUntilEpoch: 0 },
            }));
            expect(bad.some(e => e.includes('Must be one of') && e.includes('NEW_AND_MODIFIED_CODE'))).toBe(true);
        }
    });

    // framework-tag is PROJECT-level: it uses MODIFIED_PROJECTS, not the line/file-scoped modes.
    it('accepts MODIFIED_PROJECTS and rejects NEW_AND_MODIFIED_CODE for framework-tag', () => {
        const ok = errorsFor('framework-tag', validateWebpiecesConfig({
            'framework-tag': { mode: 'MODIFIED_PROJECTS', ignoreModifiedUntilEpoch: 0 },
        })).filter(e => e.includes('Must be one of'));
        expect(ok).toEqual([]);

        const bad = errorsFor('framework-tag', validateWebpiecesConfig({
            'framework-tag': { mode: 'NEW_AND_MODIFIED_CODE', ignoreModifiedUntilEpoch: 0 },
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
    it('rejects a present rule that is missing the required ignoreModifiedUntilEpoch', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-guard': { mode: 'ON' },
        });
        expect(
            errorsFor('pr-creation-guard', errors).some(
                e => e.includes('Missing required field "ignoreModifiedUntilEpoch"'),
            ),
        ).toBe(true);
    });

    it('rejects a present rule that is missing the required mode', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-guard': { ignoreModifiedUntilEpoch: 0 },
        });
        expect(
            errorsFor('pr-creation-guard', errors).some(
                e => e.includes('Missing required field "mode"'),
            ),
        ).toBe(true);
    });

    it('accepts a fully-specified rule (mode + ignoreModifiedUntilEpoch)', () => {
        const errors = validateWebpiecesConfig({
            'pr-creation-guard': { mode: 'OFF', ignoreModifiedUntilEpoch: 0 },
        });
        expect(errorsFor('pr-creation-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard accepts ON_NO_SUBBRANCHES mode and branchFormat', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': {
                mode: 'ON_NO_SUBBRANCHES',
                branchFormat: 'Name it {whoami}/<feature>',
                subBranchNaming: 'feature/<ticket>/<desc>',
                ignoreModifiedUntilEpoch: 0,
            },
        });
        expect(errorsFor('branch-creation-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard rejects an invalid mode', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': { mode: 'SOMETIMES', ignoreModifiedUntilEpoch: 0 },
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

describe('validateSectionPlacement', () => {
    it('flags a guard left in the rules section', () => {
        const errors = validateSectionPlacement({ 'pr-creation-guard': { mode: 'ON' } }, {});
        expect(errors.some(e => e.includes('[pr-creation-guard]') && e.includes('"hookGuards"'))).toBe(true);
    });

    it('flags a code rule placed in the hookGuards section', () => {
        const errors = validateSectionPlacement({}, { 'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE' } });
        expect(errors.some(e => e.includes('[no-any-unknown]') && e.includes('"rules"'))).toBe(true);
    });

    it('accepts correctly-placed entries', () => {
        const errors = validateSectionPlacement(
            { 'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE' } },
            { 'pr-creation-guard': { mode: 'ON' } },
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
            { 'pr-gate': { mode: 'OFF' }, upsertPr: 'pnpm wp-upsert-pr', mergeComplete: 'pnpm wp-git-merge-complete' },
            undefined,
        );
        expect(errors).toEqual([]);
    });

    it('rejects a non-string command field', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, upsertPr: 123 }, undefined);
        expect(errors.some(e => e.includes('[commands] "upsertPr" must be a string'))).toBe(true);
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

    it('requires name, patterns, mainMessage, mode, and epoch', () => {
        const errors = validateMatchRulesSection([{ name: '' }]);
        expect(errors.some(e => e.includes('.name must be a non-empty string'))).toBe(true);
        expect(errors.some(e => e.includes('.patterns must be a non-empty string[]'))).toBe(true);
        expect(errors.some(e => e.includes('.mainMessage must be a non-empty string'))).toBe(true);
        expect(errors.some(e => e.includes('.mode must be one of'))).toBe(true);
        expect(errors.some(e => e.includes('.ignoreModifiedUntilEpoch must be a number'))).toBe(true);
    });

    it('rejects an invalid mode value', () => {
        expect(validateMatchRulesSection([validMatchRule({ mode: 'ON' })]).some(e => e.includes('.mode must be one of'))).toBe(true);
    });

    it('flags duplicate entry names', () => {
        const errors = validateMatchRulesSection([validMatchRule(), validMatchRule()]);
        expect(errors.some(e => e.includes('duplicate entry name "no-fetch"'))).toBe(true);
    });
});
