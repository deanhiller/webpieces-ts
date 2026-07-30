import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allRuleNames, sectionForRule, CONFIG_FILENAME } from '@webpieces/rules-config';
import { RuleGate } from './rule-gate';

// A webpieces.config.json that VALIDATES: every built-in present in its correct section (all OFF),
// plus the required commands.pr-gate / excludePaths / match-rules blocks. `overrides` replaces
// individual rule entries so a test can turn one rule on/off or time-box it.
// webpieces-disable no-any-unknown -- raw config JSON is an opaque option bag, exactly as consumers write it
function writeConfig(overrides: Record<string, Record<string, unknown>> = {}): string {
    const rules: Record<string, unknown> = {};
    const hookGuards: Record<string, unknown> = {};
    for (const name of allRuleNames()) {
        // webpieces-disable no-any-unknown -- one rule's opaque option bag
        const entry: Record<string, unknown> = { mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };
        // Schema-required on this guard only (see rule-configs.ts) — unattended deletion is never a default.
        if (name === 'branch-creation-guard') entry['autoReapMergedBranches'] = false;
        const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
        // Overrides are merged OVER the base entry so a test that only tweaks mode/epoch still carries the
        // required turnOffRuleWhileOnBranch (and autoReapMergedBranches) from the base.
        target[name] = overrides[name] ? { ...entry, ...overrides[name] } : entry;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-rule-gate-'));
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({
        rules,
        hookGuards,
        commands: { 'pr-gate': { mode: 'ON', buildCommand: 'echo ci', mergeMode: 'AUTO' } },
        excludePaths: { rules: [], guards: [] },
        'match-rules': [],
    }));
    return dir;
}

const FUTURE_EPOCH = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

describe('RuleGate', () => {
    it('runs the rule when it is RUN_EVERY_TIME (the shipped default)', () => {
        const dir = writeConfig({
            'validate-packagejson': { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: 0 },
        });
        expect(new RuleGate().skipReason(dir, 'validate-packagejson', false)).toBeNull();
    });

    it('skips the rule when mode is OFF', () => {
        const dir = writeConfig();
        expect(new RuleGate().skipReason(dir, 'validate-packagejson', false)).toBe('mode: OFF');
        expect(new RuleGate().isDisabled(dir, 'validate-packagejson', false)).toBe(true);
    });

    it('honors turnOffRuleUntilEpoch for a baseline rule (honorEpoch = true)', () => {
        const dir = writeConfig({
            'validate-architecture-unchanged': { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: FUTURE_EPOCH },
        });
        const reason = new RuleGate().skipReason(dir, 'validate-architecture-unchanged', true);
        expect(reason).toContain('turnOffRuleUntilEpoch');
    });

    it('IGNORES the time-box hatch when the caller opts out with honorEpoch = false', () => {
        const dir = writeConfig({
            'validate-versions-locked': { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: FUTURE_EPOCH },
        });
        expect(new RuleGate().skipReason(dir, 'validate-versions-locked', false)).toBeNull();
    });

    it('honors validate-packagejson time-box now that its executor passes honorEpoch = true', () => {
        const dir = writeConfig({
            'validate-packagejson': { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: FUTURE_EPOCH },
        });
        expect(new RuleGate().isDisabled(dir, 'validate-packagejson', true)).toBe(true);
    });

    it('honors the new turnOffRuleUntilEpoch field name end-to-end (read directly)', () => {
        const dir = writeConfig({
            'validate-packagejson': { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: FUTURE_EPOCH },
        });
        const reason = new RuleGate().skipReason(dir, 'validate-packagejson', true);
        expect(reason).toContain('turnOffRuleUntilEpoch');
    });

    it('a past epoch leaves an epoch-gated rule active', () => {
        const dir = writeConfig({
            'validate-no-architecture-cycles': { mode: 'RUN_EVERY_TIME', turnOffRuleUntilEpoch: 0 },
        });
        expect(new RuleGate().skipReason(dir, 'validate-no-architecture-cycles', true)).toBeNull();
    });

    it('runs when the rule key is absent entirely (fail-safe: behavior unchanged for older configs)', () => {
        // No webpieces.config.json anywhere under this tmp dir chain would still walk UP to a real
        // repo config, so instead ask for a rule name that no config or default declares.
        const dir = writeConfig();
        expect(new RuleGate().skipReason(dir, 'some-rule-nobody-configured', true)).toBeNull();
    });
});
