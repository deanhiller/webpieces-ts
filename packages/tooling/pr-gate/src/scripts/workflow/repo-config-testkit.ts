import * as fs from 'fs';
import * as path from 'path';

import {
    allRuleNames, DEFAULT_REVIEWER_AGENT_NAME, retiredRuleFor, sectionForRule, seedEntryForRule,
} from '@webpieces/rules-config';

/**
 * THIS repo's own `webpieces.config.json`, prepared for use inside a temp clone.
 *
 * Specs that exercise a command end-to-end need a config the REAL validator accepts, and using the
 * repo's own file (rather than a hand-rolled minimal one) is what keeps them honest — a stub drifts out
 * from under the validator on the next config change. These adjustments are needed to make that file
 * usable outside this checkout, and all are the same for every such spec, so they live here once:
 *
 *  1. `checklists` is dropped. Its `doc` paths are validated REPO-RELATIVE and point at
 *     `.claude/review/*.md`, which exist here and not in a temp clone.
 *  2. Every locally-known rule is completed from its SEED. The repo's config is validated by the PUBLISHED
 *     validator and therefore lags local source by one release
 *     (`.claude/rules/published-vs-local-source.md`): a rule added in this working tree cannot get a
 *     config entry or newly-required field until its release ships,
 *     while the LOCAL validator a spec runs already demands one. Without this, adding any rule turns
 *     these specs red for exactly one release — a failure that says nothing about the code under test.
 *  3. Every RETIRED rule entry is dropped — the same one-release lag pointing the other way. When a rule
 *     is retired in this working tree, the repo's config must KEEP its entry until the release carrying
 *     the retirement ships (deleting it early would fail the published validator and block every Bash
 *     call), while the LOCAL validator already REJECTS it. Same trade as (2), same fix.
 *  4. A `commands.pr-gate.reviewerAgentName` naming the webpieces default WITHOUT `overrideReviewerAgent`
 *     is dropped — the same one-release lag again (issue #947). The published validator still REQUIRES the
 *     key, so the repo's config must carry it until the release making it optional ships, while the LOCAL
 *     validator already rejects a name without the override. A follow-up PR removes it from the live config.
 *
 * A testkit, not product code: nothing in a published bin imports it (same role as ai-hook-rules'
 * `shim-testkit.ts`).
 */
export class RepoConfigFixture {
    /** The repo's config as a mutable object, checklists dropped and local seed fields completed. */
    // webpieces-disable no-any-unknown -- the repo's own config document, opaque until a spec edits it
    load(): Record<string, unknown> {
        const source = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'webpieces.config.json');
        // webpieces-disable no-any-unknown -- parsed JSON, narrowed by the accessors below
        const config = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
        // webpieces-disable no-any-unknown -- narrowing one nested section
        const commands = config['commands'] as Record<string, Record<string, unknown>>;
        delete commands['pr-gate']['checklists'];
        delete commands['pr-gate']['checklistsWhy'];
        const prGate = commands['pr-gate'];
        // Local source requires this before the published validator permits the live repo to add it.
        prGate['maxReviewerRounds'] = 2;
        if (prGate['overrideReviewerAgent'] !== true && prGate['reviewerAgentName'] === DEFAULT_REVIEWER_AGENT_NAME) {
            delete prGate['reviewerAgentName'];
        }
        this.dropRetiredRules(config);
        this.completeRulesFromSeed(config);
        return config;
    }

    // Drop every rule/guard name this build knows to be RETIRED, from whichever section holds it.
    // webpieces-disable no-any-unknown -- see load()
    private dropRetiredRules(config: Record<string, unknown>): void {
        for (const section of ['rules', 'hookGuards']) {
            // webpieces-disable no-any-unknown -- narrowing one rule section
            const entries = config[section] as Record<string, unknown> | undefined;
            if (entries === undefined) continue;
            for (const name of Object.keys(entries)) {
                if (retiredRuleFor(name) !== null) delete entries[name];
            }
        }
    }

    /** Write `config` (usually a `load()` result a spec has edited) as the config of `dir`. */
    // webpieces-disable no-any-unknown -- see load()
    writeTo(dir: string, config: Record<string, unknown>): void {
        fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify(config, null, 4) + '\n');
    }

    // webpieces-disable no-any-unknown -- see load()
    private completeRulesFromSeed(config: Record<string, unknown>): void {
        // webpieces-disable no-any-unknown -- narrowing the two rule sections
        const rules = config['rules'] as Record<string, unknown>;
        // webpieces-disable no-any-unknown -- narrowing the two rule sections
        const guards = config['hookGuards'] as Record<string, unknown>;
        for (const name of allRuleNames()) {
            const section = sectionForRule(name) === 'hookGuards' ? guards : rules;
            const seed = seedEntryForRule(name);
            // webpieces-disable no-any-unknown -- one rule's opaque config entry, merged over its typed seed
            const existing = section[name] as Record<string, unknown> | undefined;
            section[name] = existing === undefined ? seed : { ...seed, ...existing };
        }
    }
}
