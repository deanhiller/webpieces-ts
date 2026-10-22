import { BaseRuleConfig } from '@webpieces/rules-sdk';
import { DiffScope } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';

import { ProjectCatalog, ProjectEntry, ScanScope } from './scan-scope';

/** A validated debug run (#1027): the one rule, the mode it runs at, and the projects it is scoped to. */
export class DebugPlan {
    constructor(
        readonly rule: string,
        readonly mode: string,
        readonly committedMode: string,
        readonly projects: readonly string[] | undefined,
    ) {}
}

/** What a debug run was asked, before it is validated against the rule's modes and the repo. Data-only. */
export class DebugAsk {
    constructor(
        readonly rule: string,
        /** `--mode`, or undefined to run at the committed mode. */
        readonly mode: string | undefined,
        readonly committedMode: string,
        /** Every mode the rule offers (OFF included); a debug run needs MODIFIED_PROJECTS and RUN_EVERY_TIME. */
        readonly modes: readonly string[],
        readonly projects: readonly string[] | undefined,
    ) {}
}

/**
 * The parts of a one-rule DEBUG run (#1027) every runner shares, so a built-in code rule and a repo-local
 * rule (#1330) refuse, announce, override and count identically: the same refusals, the same banner, the
 * same in-memory override (mode replaced, both escape hatches cleared) and the same per-project count.
 * The runner owns only the part between banner and count — running the rule through a {@link ScanScope}
 * restricted to the plan's projects and recording each site there.
 */
export class RuleDebugRun {
    /** True when a rule offering `modes` can be debug-run: it judges whole projects and the whole repo. */
    supports(modes: readonly string[]): boolean {
        return modes.includes('MODIFIED_PROJECTS') && modes.includes('RUN_EVERY_TIME');
    }

    /** Validate `ask` against the rule's modes and the repo's projects; throws a refusal naming the cure. */
    async plan(workspaceRoot: string, ask: DebugAsk): Promise<DebugPlan> {
        const mode = ask.mode ?? ask.committedMode;
        if (!ask.modes.includes(mode) || mode === 'OFF') {
            const why =
                ask.mode === undefined
                    ? `its committed mode is ${ask.committedMode}`
                    : `--mode=${mode} is not one of its modes`;
            throw this.refusal(
                `${ask.rule} cannot run: ${why}. Pass --mode=<one of ${ask.modes.filter((m: string) => m !== 'OFF').join(', ')}>.`,
            );
        }
        const known = await this.projectNames(workspaceRoot);
        const unknown = (ask.projects ?? []).filter((name: string) => !known.includes(name));
        if (unknown.length > 0) {
            throw this.refusal(
                `--projects names no such nx project: ${unknown.join(', ')}. Known projects: ${known.join(', ')}.`,
            );
        }
        return new DebugPlan(ask.rule, mode, ask.committedMode, ask.projects);
    }

    refusal(reason: string): InformAiError {
        return new InformAiError(`[debug run] ${reason}`);
    }

    /** A copy of `config` at the plan's mode with both escape hatches cleared. The original is untouched. */
    overridden<C extends BaseRuleConfig>(config: C, plan: DebugPlan): C {
        const copy = Object.assign(
            Object.create(Object.getPrototypeOf(config) as object) as C,
            config,
        );
        copy.mode = plan.mode;
        copy.turnOffRuleUntilEpoch = 0;
        copy.turnOffRuleWhileOnBranch = null;
        return copy;
    }

    printBanner(plan: DebugPlan): void {
        console.log('');
        console.log(
            `🔍 DEBUG RUN of ${plan.rule} — NOT the gate. webpieces.config.json is unchanged and nothing is written.`,
        );
        console.log(
            `   Mode: ${plan.mode} (committed: ${plan.committedMode})` +
                ` · Projects: ${plan.projects === undefined ? 'every project' : plan.projects.join(', ')}` +
                ' · escape hatches (turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch) ignored for this run',
        );
    }

    /** Print one count per project from the sites recorded in `scan`, and return the total. */
    async printCounts(workspaceRoot: string, plan: DebugPlan, scan: ScanScope, ruleSucceeded: boolean): Promise<number> {
        const counts = await scan.countsByProject(workspaceRoot);
        const names = plan.projects ?? Array.from(counts.keys()).sort();
        const total = Array.from(counts.values()).reduce((sum: number, n: number) => sum + n, 0);
        console.log('');
        console.log(`🔍 ${plan.rule} at ${plan.mode}: ${total} site(s) left`);
        for (const name of names) console.log(`   ${name}: ${counts.get(name) ?? 0}`);
        if (!ruleSucceeded && total === 0) {
            console.log('   (the rule failed without reporting sites — read its output above)');
        }
        console.log('');
        return total;
    }

    private async projectNames(workspaceRoot: string): Promise<string[]> {
        return (await new ProjectCatalog(new DiffScope())
            .all(workspaceRoot))
            .map((p: ProjectEntry) => p.name)
            .sort();
    }
}
