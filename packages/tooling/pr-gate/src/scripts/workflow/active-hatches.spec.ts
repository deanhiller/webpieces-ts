import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILENAME, ConfigFile } from '@webpieces/rules-config';
import { describe, it, expect, beforeEach } from 'vitest';

import { ActiveHatch, ActiveHatchReport } from './active-hatches';

const DAY = 24 * 60 * 60;

describe('ActiveHatchReport', () => {
    let repoRoot = '';
    let report = new ActiveHatchReport(new ConfigFile());

    beforeEach(() => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-hatch-'));
        report = new ActiveHatchReport(new ConfigFile());
    });

    // webpieces-disable no-any-unknown -- a config FIXTURE, written straight to JSON
    function writeConfig(config: Record<string, unknown>): void {
        fs.writeFileSync(path.join(repoRoot, CONFIG_FILENAME), JSON.stringify(config));
    }

    function names(hatches: readonly ActiveHatch[]): string[] {
        return hatches.map((h: ActiveHatch): string => `${h.ruleName} ${h.hatchField}`);
    }

    // The overwhelmingly common config: both hatches at their inert values on every rule. Nothing is
    // printed at all, so the dashboard does not grow a permanent empty section.
    it('finds nothing, and renders nothing, when every hatch is inert', () => {
        writeConfig({
            rules: {
                'no-any-unknown': { mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null },
                // A PAST epoch is inert — it skips nothing. Listing those would bury the live ones.
                'max-file-lines': {
                    mode: 'ON',
                    turnOffRuleUntilEpoch: Math.floor(Date.now() / 1000) - 30 * DAY,
                    turnOffRuleWhileOnBranch: null,
                },
            },
        });

        expect(report.scan(repoRoot)).toEqual([]);
        expect(report.render(report.scan(repoRoot))).toBe('');
    });

    it('lists a branch hatch and a FUTURE epoch hatch, from rules and hookGuards alike', () => {
        writeConfig({
            rules: {
                'no-any-unknown': { mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: 'dean/big-refactor' },
                'max-file-lines': {
                    mode: 'ON',
                    turnOffRuleUntilEpoch: Math.floor(Date.now() / 1000) + 10 * DAY,
                    turnOffRuleWhileOnBranch: null,
                },
            },
            hookGuards: {
                'branch-state-guard': { mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: 'dean/spike' },
            },
        });

        expect(names(report.scan(repoRoot))).toEqual([
            'no-any-unknown turnOffRuleWhileOnBranch',
            'max-file-lines turnOffRuleUntilEpoch',
            'branch-state-guard turnOffRuleWhileOnBranch',
        ]);
    });

    it('covers match-rules entries, which name themselves', () => {
        writeConfig({
            'match-rules': [
                { name: 'no-raw-http', mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: 'dean/http' },
            ],
        });

        expect(names(report.scan(repoRoot))).toEqual(['no-raw-http turnOffRuleWhileOnBranch']);
    });

    // The rendered section is what a human actually reads on the PR — the rule, WHICH hatch, and the value
    // (a date for an epoch, so "how long has this been off?" is answerable at a glance).
    it('renders the rule, the hatch field and a human value', () => {
        const epoch = Math.floor(Date.now() / 1000) + 10 * DAY;
        const expectedDate = new Date(epoch * 1000).toISOString().split('T')[0];
        const rendered = report.render([
            new ActiveHatch('no-any-unknown', 'turnOffRuleWhileOnBranch', '"dean/big-refactor"'),
            new ActiveHatch('no-file-import-cycles', 'turnOffRuleUntilEpoch', expectedDate),
        ]);

        expect(rendered).toContain('2 rule hatch(es) are currently active');
        expect(rendered).toContain('no-any-unknown');
        expect(rendered).toContain('turnOffRuleWhileOnBranch = "dean/big-refactor"');
        expect(rendered).toContain(`turnOffRuleUntilEpoch    = ${expectedDate}`);
        // Informational only — nothing in it may read as an instruction or a gate.
        expect(rendered).toContain('Not blocking');
    });
});
