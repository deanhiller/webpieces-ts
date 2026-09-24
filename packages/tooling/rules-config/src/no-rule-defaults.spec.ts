/**
 * A RULE MUST NOT HAVE A DEFAULT (#1017).
 *
 * The consumer decides whether a rule runs, and states that decision in their own
 * `webpieces.config.json`. `defaultRules` is TUNING ONLY — the value an OPTIONAL field takes when a
 * consumer omits it — so it may never carry `mode`, and it may never carry a field the rule's schema
 * marks REQUIRED. Either would be webpieces answering, invisibly, a question the consumer was never
 * asked: whether the rule runs at all, which branch names are blocked, whether merged branches are
 * deleted unattended.
 *
 * These assertions are what makes that mechanical rather than a habit. `defaults` is the exact defect
 * #1017 measured six instances of; `demanded` is the other half — the guarantee that an unconfigured
 * rule FAILS THE LOAD, which is what makes having no default safe.
 */
import { describe, it, expect } from 'vitest';
import { defaultRules } from './default-rules';
import { RULE_SCHEMAS } from './rule-schemas';
import { validateWebpiecesConfig } from './validate-config';
import { recommendedSeedMode, seedEntryForRule } from './seed-entry';

describe('a rule has no default', () => {
    it('defaultRules never carries `mode` for any rule', () => {
        const offenders = Object.keys(defaultRules).filter(
            (name: string): boolean => 'mode' in defaultRules[name],
        );
        expect(offenders).toEqual([]);
    });

    it('defaultRules never carries a schema-REQUIRED field', () => {
        const offenders: string[] = [];
        for (const name of Object.keys(defaultRules)) {
            const schema = RULE_SCHEMAS[name];
            if (schema === undefined) continue;
            for (const field of Object.keys(defaultRules[name])) {
                if (schema[field] !== undefined && !schema[field].optional) {
                    offenders.push(`${name}.${field}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every rule with a schema is DEMANDED of the config — an absent entry fails the load', () => {
        for (const name of Object.keys(RULE_SCHEMAS)) {
            const others: Record<string, Record<string, unknown>> = {};
            for (const other of Object.keys(RULE_SCHEMAS)) {
                if (other !== name) others[other] = seedEntryForRule(other);
            }
            const errors = validateWebpiecesConfig(others, false);
            expect(errors.join('\n')).toContain(`[${name}] Not configured in webpieces.config.json`);
        }
    });

    it('the six #1017 measured have no default at all left', () => {
        const measured = [
            'branch-creation-guard',
            'pr-lifecycle-guard',
            'branch-state-guard',
            'no-root-union-api-type',
            'api-rules-for-openapi',
            'api-rules-for-mcp',
        ];
        for (const name of measured) {
            expect(defaultRules[name]).toEqual({});
        }
    });

    /**
     * The five Nx infrastructure validators enforced unconditionally before they were wired to
     * config, and their `defaultRules` mode was RUN_EVERY_TIME so an upgrade never silently stopped
     * a CI gate. That default is gone, and what replaces it is stronger: an upgrade stating no mode
     * for one of them FAILS THE LOAD naming it, and the entry a consumer pastes says RUN_EVERY_TIME.
     */
    it('the Nx infrastructure validators are DEMANDED of the config, and seed RUN_EVERY_TIME', () => {
        const infra = [
            'validate-architecture-unchanged', 'validate-no-architecture-cycles',
            'validate-packagejson', 'validate-versions-locked', 'validate-eslint-sync',
        ];
        for (const name of infra) {
            expect(RULE_SCHEMAS[name]).toBeDefined();
            expect(defaultRules[name]?.['mode']).toBeUndefined();
            expect(recommendedSeedMode(name)).toBe('RUN_EVERY_TIME');
        }
    });

    it('branch-creation-guard demands BOTH behaviour fields, not just mode', () => {
        const schema = RULE_SCHEMAS['branch-creation-guard'];
        expect(schema['subBranchNaming'].optional).toBe(false);
        expect(schema['autoReapMergedBranches'].optional).toBe(false);
        // The numeric caps stay optional knobs on purpose — the refusal prints the cap it hit.
        expect(schema['maxLocalBranches'].optional).toBe(true);
        expect(schema['maxWorktrees'].optional).toBe(true);
    });

    it('no-utility-types-in-api-lib demands `paths` as well as mode — which files are contracts is the consumer\'s call', () => {
        const schema = RULE_SCHEMAS['no-utility-types-in-api-lib'];
        expect(schema['mode'].optional).toBe(false);
        expect(schema['paths'].optional).toBe(false);
        expect(schema['allowedPaths'].optional).toBe(true);
        expect(defaultRules['no-utility-types-in-api-lib']).toEqual({});
        expect(seedEntryForRule('no-utility-types-in-api-lib')['paths']).toEqual(['libraries/apis/**']);
    });
});
