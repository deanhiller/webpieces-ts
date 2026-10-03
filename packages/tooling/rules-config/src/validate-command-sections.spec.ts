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

describe('validatePrGateSection', () => {
    it('errors with a copy-paste example when the block is missing', () => {
        const errors = validatePrGateSection(undefined);
        expect(errors.some((e) => e.includes('[pr-gate] Not configured'))).toBe(true);
        expect(errors.some((e) => e.includes('"buildCommand"'))).toBe(true);
    });

    it('requires buildCommand when mode is ON', () => {
        const errors = validatePrGateSection({ mode: 'ON' });
        expect(errors.some((e) => e.includes('Missing required field "buildCommand"'))).toBe(true);
    });

    it('does not require buildCommand when mode is OFF', () => {
        expect(validatePrGateSection({ mode: 'OFF' })).toEqual([]);
    });

    it('accepts a full valid block (warningColor + disabled example gate)', () => {
        const errors = validatePrGateSection({
            mode: 'ON',
            buildCommand: 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)',
            mergeMode: 'AUTO',
            reviewerAgents: 1,
            maxReviewerRounds: 2,
            gates: [
                { name: 'API', patterns: ['**/*Api.ts'], warningColor: 'yellow' },
                {
                    name: 'DB Schema',
                    patterns: ['**/schema.prisma'],
                    warningColor: 'red',
                    disabled: true,
                },
            ],
        });
        expect(errors).toEqual([]);
    });

    it('rejects a gate missing the required warningColor', () => {
        const bad = validatePrGateSection({
            mode: 'ON',
            buildCommand: 'x',
            gates: [{ name: 'API', patterns: ['**/*Api.ts'] }],
        });
        expect(bad.some((e) => e.includes('gates[0].warningColor is required'))).toBe(true);
    });

    it('rejects an invalid mode and malformed gates', () => {
        const bad = validatePrGateSection({
            mode: 'MAYBE',
            buildCommand: 'x',
            gates: [{ patterns: 'nope' }],
        });
        expect(bad.some((e) => e.includes('"mode" = "MAYBE" is not valid'))).toBe(true);
        expect(bad.some((e) => e.includes('gates[0].name must be a string'))).toBe(true);
        expect(bad.some((e) => e.includes('gates[0].patterns must be string[]'))).toBe(true);
    });

    it('rejects an invalid gate warningColor and a non-boolean disabled', () => {
        const bad = validatePrGateSection({
            mode: 'ON',
            buildCommand: 'x',
            gates: [{ name: 'X', patterns: ['**/*.ts'], warningColor: 'warn', disabled: 'nope' }],
        });
        expect(bad.some((e) => e.includes('gates[0].warningColor must be "yellow" or "red"'))).toBe(
            true,
        );
        expect(bad.some((e) => e.includes('gates[0].disabled must be a boolean'))).toBe(true);
    });
});

// Split from the block above only because the combined describe() callback exceeded max-method-lines.
describe('validatePrGateSection — mergeMode (required policy)', () => {
    it('REQUIRES mergeMode — the policy is never guessed', () => {
        const bad = validatePrGateSection({ mode: 'ON', buildCommand: 'x' });
        expect(bad.some((e) => e.includes('Missing required field "mergeMode"'))).toBe(true);
    });

    it('accepts every valid mergeMode', () => {
        for (const mergeMode of ['AUTO', 'NONE']) {
            expect(
                validatePrGateSection({
                    mode: 'ON',
                    buildCommand: 'x',
                    mergeMode,
                    reviewerAgents: 1,
                    maxReviewerRounds: 2,
                }),
            ).toEqual([]);
        }
    });

    it('rejects an unknown mergeMode and explains what each mode costs', () => {
        const bad = validatePrGateSection({
            mode: 'ON',
            buildCommand: 'x',
            mergeMode: 'DETECT',
            reviewerAgents: 1,
            maxReviewerRounds: 2,
        });
        expect(bad.some((e) => e.includes('"mergeMode" = "DETECT" is not valid'))).toBe(true);
        expect(bad.some((e) => e.includes('allow_auto_merge'))).toBe(true);
        expect(bad.some((e) => e.includes('squash_merge_commit_title'))).toBe(true);
        // NONE must not read as "and now go configure two repo settings" — SquashSettingsEnforcer pins
        // them, and this help text claimed the compact body was "impossible" on NONE for one release.
        expect(bad.some((e) => e.includes('impossible'))).toBe(false);
    });

    it('does NOT require mergeMode when the whole gate is OFF', () => {
        expect(validatePrGateSection({ mode: 'OFF' })).toEqual([]);
    });
});

describe('validateMatchRulesSection', () => {
    it('errors when missing, printing the ready-to-paste no-fetch example', () => {
        const errors = validateMatchRulesSection(undefined);
        expect(errors.some((e) => e.includes('[match-rules] Not configured'))).toBe(true);
        // The printed example seeds the no-fetch guard so a client can copy it in.
        expect(errors.some((e) => e.includes('"match-rules"') && e.includes('"no-fetch"'))).toBe(
            true,
        );
    });

    it('accepts an empty array (a conscious opt-out)', () => {
        expect(validateMatchRulesSection([])).toEqual([]);
    });

    it('accepts a fully-specified valid entry', () => {
        expect(
            validateMatchRulesSection([
                validMatchRule({
                    options: ['a', 'b'],
                    allowedPaths: ['packages/**'],
                    disableAllowed: true,
                }),
            ]),
        ).toEqual([]);
    });

    it('rejects a non-array section', () => {
        expect(
            validateMatchRulesSection({ name: 'no-fetch' }).some((e) =>
                e.includes('Must be an array'),
            ),
        ).toBe(true);
    });

    it('reports an invalid regex with the entry name and index', () => {
        const errors = validateMatchRulesSection([validMatchRule({ patterns: ['('] })]);
        expect(errors.some((e) => e.includes('"no-fetch".patterns[0] is not a valid regex'))).toBe(
            true,
        );
    });

    it('requires name, patterns, mainMessage, mode, and BOTH escape hatches', () => {
        const errors = validateMatchRulesSection([{ name: '' }]);
        expect(errors.some((e) => e.includes('.name must be a non-empty string'))).toBe(true);
        expect(errors.some((e) => e.includes('.patterns must be a non-empty string[]'))).toBe(true);
        expect(errors.some((e) => e.includes('.mainMessage must be a non-empty string'))).toBe(
            true,
        );
        expect(errors.some((e) => e.includes('.mode must be one of'))).toBe(true);
        // Both hatches are required on match-rules too.
        expect(errors.some((e) => e.includes('.turnOffRuleUntilEpoch must be a number'))).toBe(
            true,
        );
        expect(
            errors.some((e) => e.includes('.turnOffRuleWhileOnBranch must be a string or null')),
        ).toBe(true);
    });

    it('validates the epoch hatch type when present', () => {
        // webpieces-disable no-any-unknown -- deliberately wrong type for the negative test
        const errors = validateMatchRulesSection([
            validMatchRule({ turnOffRuleUntilEpoch: 'soon' as unknown as number }),
        ]);
        expect(errors.some((e) => e.includes('.turnOffRuleUntilEpoch must be a number'))).toBe(
            true,
        );
    });

    it('accepts a null branch hatch and flags the renamed old names', () => {
        expect(
            validateMatchRulesSection([
                validMatchRule({
                    turnOffRuleUntilEpoch: 1771931925,
                    turnOffRuleWhileOnBranch: 'deanhiller/foo',
                }),
            ]),
        ).toEqual([]);
        // webpieces-disable no-any-unknown -- deliberately the removed old name for the negative test
        const renamed = validateMatchRulesSection([
            validMatchRule({ ignoreModifiedUntilEpoch: 0 } as Record<string, unknown>),
        ]);
        expect(
            renamed.some((e) =>
                e.includes(
                    '"ignoreModifiedUntilEpoch" — it was renamed to "turnOffRuleUntilEpoch"',
                ),
            ),
        ).toBe(true);
    });

    it('rejects an invalid mode value', () => {
        expect(
            validateMatchRulesSection([validMatchRule({ mode: 'ON' })]).some((e) =>
                e.includes('.mode must be one of'),
            ),
        ).toBe(true);
    });

    it('flags duplicate entry names', () => {
        const errors = validateMatchRulesSection([validMatchRule(), validMatchRule()]);
        expect(errors.some((e) => e.includes('duplicate entry name "no-fetch"'))).toBe(true);
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
        const schema = new Set(allRuleNames(fixtureRuleRegistry));
        const missing = HOOK_GUARD_NAMES.filter((name: string): boolean => !schema.has(name));
        expect(missing).toEqual([]);
    });

    it('allRuleNames is exactly the schema keys, so the installer seeds every known rule', () => {
        // allRuleNames drives buildSeedConfig; a name missing here can never be seeded and a repo
        // could not add it via the install command.
        expect(allRuleNames(fixtureRuleRegistry).length).toBeGreaterThan(0);
        // The branch-state POLICY, not the four class names behind it. `read-stale-guard` used to be
        // asserted here; it is now a rule NAME with no config key of its own, so demanding a schema for
        // it would recreate the exact deadlock this describe block exists to prevent — the validator
        // demanding a key that RETIRED_CONFIG_KEYS then rejects.
        expect(new Set(allRuleNames(fixtureRuleRegistry)).has('branch-state-guard')).toBe(true);
    });

    // The other half of that deadlock, in the new direction the collapse opens up: a rule NAME must
    // never acquire a schema, because a schema is what makes the validator demand a config entry.
    it('no retired class-named guard has a schema, so the validator can never demand a rejected key', () => {
        const schema = new Set(allRuleNames(fixtureRuleRegistry));
        const retiredNames = [
            'feature-branch-guard',
            'read-stale-guard',
            'stale-main-bash-guard',
            'merged-branch-bash-guard',
            'pr-creation-or-push-guard',
            'merge-in-progress-guard',
            'pr-merge-guard',
            'redirect-how-to-merge-main',
        ];
        expect(retiredNames.filter((name: string): boolean => schema.has(name))).toEqual([]);
    });

    it('every defaultRules key has a schema (else the loader defaults a rule the validator rejects)', () => {
        const schema = new Set(allRuleNames(fixtureRuleRegistry));
        const missing = Object.keys(defaultRules).filter(
            (name: string): boolean => !schema.has(name),
        );
        expect(missing).toEqual([]);
    });

    // The five Nx infrastructure validators moved to no-rule-defaults.spec.ts (#1017): they have
    // no default, and what replaces one is that the config is DEMANDED to state their mode.
});

// webpieces-disable no-any-unknown -- a raw pr-gate section from a test
function validPrGate(checklists: unknown): Record<string, unknown> {
    return {
        mode: 'ON',
        buildCommand: 'pnpm ci',
        mergeMode: 'AUTO',
        reviewerAgents: 1,
        maxReviewerRounds: 2,
        gates: [],
        checklists,
    };
}

// A temp repo root, optionally with `.claude/review/<doc>` files and `.claude/agents/<name>.md` reviewers.
function repoWith(docs: string[] = [], agents: string[] = []): string {
    const dir = policyFixture.makeRepo('wp-checklists-');
    fs.mkdirSync(path.join(dir, '.claude', 'review'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(dir, '.claude', 'review', d), '# doc');
    if (agents.length > 0) {
        fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
        for (const a of agents)
            fs.writeFileSync(path.join(dir, '.claude', 'agents', `${a}.md`), '# agent');
    }
    return dir;
}

describe('validatePrGateSection rejects gateSaltWhy', () => {
    it('tells the consumer to delete it, so the next validate on upgrade forces removal', () => {
        const section = {
            mode: 'ON',
            buildCommand: 'pnpm ci',
            mergeMode: 'AUTO',
            reviewerAgents: 1,
            maxReviewerRounds: 2,
            gateSalt: 's',
            gateSaltWhy: 'it works like this...',
        };
        const errors = validatePrGateSection(section);
        expect(errors.some((e: string): boolean => /DELETE the "gateSaltWhy" key/.test(e))).toBe(
            true,
        );
    });

    it('leaves every other *Why rationale key alone', () => {
        const section = {
            mode: 'ON',
            buildCommand: 'pnpm ci',
            mergeMode: 'AUTO',
            reviewerAgents: 1,
            maxReviewerRounds: 2,
            buildCommandWhy: 'because',
            gatesWhy: 'because',
        };
        expect(validatePrGateSection(section)).toEqual([]);
    });
});

// recommendedSeedMode is the ONE source of truth for "what mode should this rule arrive as" — used by
// the validator's copy-paste snippet, by the installer's seeding, and by fault Y's deny.
describe('recommendedSeedMode', () => {
    it('prefers the narrowest gradual mode a rule supports', () => {
        expect(
            recommendedSeedModeFor([
                'OFF',
                'ON',
                'NEW_AND_MODIFIED_FILES',
                'NEW_AND_MODIFIED_CODE',
            ]),
        ).toEqual('NEW_AND_MODIFIED_CODE');
        // A project-wide mode is the BROADEST gradual mode, so a narrower one wins (#1027) …
        expect(
            recommendedSeedModeFor(['OFF', 'ON', 'MODIFIED_CLASS', 'MODIFIED_PROJECTS']),
        ).toEqual('MODIFIED_CLASS');
        // … and a project rule, which offers nothing narrower, still arrives as MODIFIED_PROJECTS.
        expect(recommendedSeedModeFor(['OFF', 'MODIFIED_PROJECTS', 'AFFECTED_PROJECT'])).toEqual(
            'MODIFIED_PROJECTS',
        );
    });

    it('keeps a line-scoped rule at NEW_AND_MODIFIED_CODE now that it also offers the whole-scope modes (#1027)', () => {
        expect(recommendedSeedModeFor(MODIFIED_CODE_MODES)).toEqual('NEW_AND_MODIFIED_CODE');
        expect(recommendedSeedMode('one-enum-spelling-in-api-lib', fixtureRuleRegistry)).toEqual(
            'NEW_AND_MODIFIED_CODE',
        );
        expect(recommendedSeedMode('no-destructure', fixtureRuleRegistry)).toEqual(
            'NEW_AND_MODIFIED_CODE',
        );
    });

    it('falls back ON -> RUN_EVERY_TIME -> OFF when no gradual mode is offered', () => {
        expect(recommendedSeedModeFor(['OFF', 'ON'])).toEqual('ON');
        expect(recommendedSeedModeFor(['OFF', 'RUN_EVERY_TIME'])).toEqual('RUN_EVERY_TIME');
        expect(recommendedSeedModeFor(['OFF'])).toEqual('OFF');
        expect(recommendedSeedModeFor([])).toEqual('OFF');
    });

    it('never recommends OFF for a built-in rule — seeding a fresh config leaves everything enforcing', () => {
        for (const name of allRuleNames(fixtureRuleRegistry)) {
            expect(recommendedSeedMode(name, fixtureRuleRegistry), name).not.toEqual('OFF');
        }
    });

    it('requires owner metadata before recommending a mode for a client policy', () => {
        expect(() => recommendedSeedMode('some-custom-rule', fixtureRuleRegistry)).toThrow(
            'No selected owner supplies a seed',
        );
    });
});

// seedEntryForRule is what the installer writes, so it must satisfy the validator that reads the same
// schema. The end-to-end version of this lives in ai-hook-rules/src/bin/setup.spec.ts (it runs a real
// migrate() through validateWebpiecesConfig); this one pins the per-field default selection.
describe('seedEntryForRule', () => {
    it('emits EVERY schema-required field, not just mode + the two hatches', () => {
        // The gap this closed: a seeded branch-creation-guard had no autoReapMergedBranches, so a fresh
        // install wrote a config that failed to load. The values come from SEED_VALUES (seed-entry.ts)
        // now that no rule has a DEFAULT (#1017) — autoReap seeds FALSE ("nobody answered" = delete
        // nothing).
        expect(seedEntryForRule('branch-creation-guard', fixtureRuleRegistry)).toEqual({
            mode: 'ON',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
            autoReapMergedBranches: false,
            subBranchNaming: 'feature/<ticket>/<short-description>',
        });
    });

    it('always carries both escape hatches in their active state, at the recommended mode', () => {
        for (const name of allRuleNames(fixtureRuleRegistry)) {
            const entry = seedEntryForRule(name, fixtureRuleRegistry);
            expect(entry['mode'], name).toEqual(recommendedSeedMode(name, fixtureRuleRegistry));
            expect(entry['turnOffRuleUntilEpoch'], name).toEqual(0);
            expect(entry['turnOffRuleWhileOnBranch'], name).toEqual(null);
        }
    });

    it('requires a declared owner seed instead of inventing settings for an unknown client policy', () => {
        expect(() => seedEntryForRule('some-custom-rule', fixtureRuleRegistry)).toThrow(
            'No selected owner supplies a seed',
        );
    });
});

/**
 * `pr-gate.devDeploy` — where wp-push-dev publishes the disposable copy. Optional with defaults, so
 * every existing consumer config keeps validating untouched; present, it has to be usable as a git ref,
 * because these two values are concatenated into a ref that a command then force-pushes.
 */
describe('validatePrGateSection — devDeploy', () => {
    const base = {
        mode: 'ON',
        buildCommand: 'x',
        mergeMode: 'AUTO',
        reviewerAgents: 1,
        maxReviewerRounds: 2,
    };

    it('accepts a config that omits it entirely', () => {
        expect(validatePrGateSection(base)).toEqual([]);
    });

    it('accepts explicit names', () => {
        expect(
            validatePrGateSection({
                ...base,
                devDeploy: { branchNamespace: 'staging-include', devBranch: 'staging' },
            }),
        ).toEqual([]);
    });

    it('accepts overriding only one of the two', () => {
        expect(validatePrGateSection({ ...base, devDeploy: { devBranch: 'staging' } })).toEqual([]);
    });

    it('rejects a name git could not use as a ref', () => {
        const bad = validatePrGateSection({
            ...base,
            devDeploy: { branchNamespace: 'dev include!' },
        });
        expect(bad.length).toBe(1);
        expect(bad[0]).toContain('not a usable git ref name');
    });

    it('rejects an empty name rather than silently falling back to the default', () => {
        expect(validatePrGateSection({ ...base, devDeploy: { devBranch: '  ' } })[0]).toContain(
            'non-empty string',
        );
    });

    it('rejects a devBranch with a slash — it is a branch, not a namespace', () => {
        expect(
            validatePrGateSection({ ...base, devDeploy: { devBranch: 'shared/dev' } })[0],
        ).toContain('single ref name with no "/"');
    });

    it('rejects a devBranch nested inside the namespace, which would make --list enumerate it', () => {
        const bad = validatePrGateSection({
            ...base,
            devDeploy: { branchNamespace: 'dev', devBranch: 'dev' },
        });
        expect(bad[0]).toContain('must not contain one another');
    });

    it('rejects a non-object', () => {
        expect(validatePrGateSection({ ...base, devDeploy: 'dev-include' })[0]).toContain(
            'must be an object',
        );
    });
});
