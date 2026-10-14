/**
 * The runtime architecture GOAL (#1239): `architecture/runtime-dependencies-goal.json`.
 *
 * A proposal, not a fact. `architecture/runtime-dependencies.json` is GENERATED from source and its
 * unchanged-validator rightly treats any hand edit as drift, so a proposal needs its own durable,
 * reviewable file in the same RuntimeGraph shape. Nothing in the generator reads, writes or deletes
 * this file: only a person (or an AI) edits it, and only the explicit `--prepare` step below rewrites
 * its derived fields.
 *
 * Errors here never tell anyone to regenerate from source — a goal has no source. They name the goal
 * path, the broken element, and the edit or the explicit preparation command that repairs it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RuleFailError, Option } from '@webpieces/rules-config';
import type { RuntimeGraph, RuntimeQueueFlow, RuntimeTrigger } from './runtime-graph-model';
import { DEFAULT_RUNTIME_GRAPH_PATH, saveRuntimeGraph } from './runtime-graph-io';
import { RuntimeNodeLevels } from './runtime-node-levels';
import { RuntimeGoalValidator } from './runtime-goal-validator';
import { toError } from '../toError';

export const DEFAULT_RUNTIME_GOAL_PATH = 'architecture/runtime-dependencies-goal.json';
export const RUNTIME_GOAL_RULE_NAME = 'runtime-architecture-goal';
export const RUNTIME_GOAL_PREPARE_COMMAND = 'pnpm nx run architecture:visualize-runtime-goal --prepare';
export const RUNTIME_GOAL_INIT_COMMAND = `cp ${DEFAULT_RUNTIME_GRAPH_PATH} ${DEFAULT_RUNTIME_GOAL_PATH}`;

/** The derived fields `--prepare` rewrote, as `field: before → after` lines; empty when none moved. */
export class RuntimeGoalPreparation {
    constructor(
        public readonly graph: RuntimeGraph,
        public readonly changes: string[],
        /** Whether the goal file was rewritten (also true when only explanatory levelBecause text moved). */
        public readonly written: boolean,
    ) {}
}

/**
 * What viewing found about the goal's derived facts: a CYCLE (only an edit of runtimeEdges fixes it,
 * `--prepare` refuses it too) or field DIFFERENCES that `--prepare` would rewrite.
 */
export class RuntimeGoalDrift {
    constructor(
        public readonly cycle: string | null,
        public readonly differences: string[],
    ) {}
}

/** Loads, checks and (only on request) prepares the hand-authored runtime goal. */
export class RuntimeGoalFile {
    private readonly validator: RuntimeGoalValidator;

    constructor(public readonly goalPath: string = DEFAULT_RUNTIME_GOAL_PATH) {
        this.validator = new RuntimeGoalValidator(goalPath);
    }

    exists(workspaceRoot: string): boolean {
        return fs.existsSync(path.join(workspaceRoot, this.goalPath));
    }

    /** The goal as saved, after its shape, references and derived facts check out. Never writes anything. */
    load(workspaceRoot: string): RuntimeGraph {
        const parsed = this.structurallyValid(workspaceRoot);
        const derived = this.validator.derived(parsed);
        if (derived.length > 0)
            throw this.failure(`${this.goalPath} lacks derived facts the viewer needs:\n  ${derived.join('\n  ')}`, [
                new Option(`Compute them from the goal's relationships: ${RUNTIME_GOAL_PREPARE_COMMAND}`, true),
                this.editOption(false),
            ]);
        return parsed;
    }

    /**
     * Where the saved derived facts disagree with what the existing runtime level machinery
     * (RuntimeNodeLevels — the generator's own) computes from the goal's relationships. Reported, not
     * fixed: viewing is read-only, and `--prepare` is the explicit step that rewrites them.
     */
    drift(graph: RuntimeGraph): RuntimeGoalDrift {
        const recomputed = this.recompute(graph);
        if (typeof recomputed === 'string') return new RuntimeGoalDrift(recomputed, []);
        return new RuntimeGoalDrift(null, this.differences(graph, recomputed));
    }

    /**
     * Recompute levels, self-queue flags, contract queues and maxLevel, and WRITE the goal. Gated on
     * STRUCTURAL problems only: missing or stale derived facts are exactly what this step computes.
     */
    prepare(workspaceRoot: string): RuntimeGoalPreparation {
        const saved = this.structurallyValid(workspaceRoot);
        const recomputed = this.recompute(saved);
        if (typeof recomputed === 'string') throw this.failure(recomputed, [this.cycleOption()]);
        const changes = this.differences(saved, recomputed);
        const written = JSON.stringify(saved) !== JSON.stringify(recomputed);
        if (written) saveRuntimeGraph(recomputed, workspaceRoot, this.goalPath);
        return new RuntimeGoalPreparation(recomputed, changes, written);
    }

    /** The edit that clears a cycle verdict — `--prepare` cannot. */
    cycleOption(): Option {
        return new Option(`Break the cycle by editing "runtimeEdges" (or the queues it flows through) in ${this.goalPath}.`, true);
    }

    private structurallyValid(workspaceRoot: string): RuntimeGraph {
        if (!this.exists(workspaceRoot)) throw this.missing();
        let parsed: RuntimeGraph;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- hand-authored JSON decoding boundary adds the goal path and repair while preserving the cause
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, this.goalPath), 'utf-8')) as RuntimeGraph;
        } catch (err: unknown) {
            const error = toError(err);
            throw this.failure(`${this.goalPath} is not valid JSON: ${error.message}`, [this.editOption(true)], error);
        }
        const problems = this.validator.structural(parsed);
        if (problems.length > 0)
            throw this.failure(`${this.goalPath} is not a usable runtime goal:\n  ${problems.join('\n  ')}`, [this.editOption(true)]);
        return parsed;
    }

    /** A deep copy with the generator's level machinery applied, or the cycle it refused. */
    private recompute(graph: RuntimeGraph): RuntimeGraph | string {
        const copy = JSON.parse(JSON.stringify(graph)) as RuntimeGraph;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the shared level machinery throws its cycle verdict; the goal reports it against its own path
        try {
            new RuntimeNodeLevels().apply(copy);
            return copy;
        } catch (err: unknown) {
            const error = toError(err);
            if (!(error instanceof RuleFailError)) throw error;
            return `${this.goalPath} describes a runtime graph the level machinery cannot order: ${error.message}`;
        }
    }

    private differences(saved: RuntimeGraph, recomputed: RuntimeGraph): string[] {
        const lines: string[] = [];
        const level = (where: string, before: number | undefined, after: number): void => {
            if (before !== after) lines.push(`${where} level: L${before ?? '?'} → L${after}`);
        };
        for (const [name, service] of Object.entries(recomputed.services)) level(`services["${name}"]`, saved.services[name].level, service.level);
        for (const [key, queue] of Object.entries(recomputed.queues)) {
            level(`queues["${key}"]`, saved.queues[key].level, queue.level);
            if (saved.queues[key].selfQueue !== queue.selfQueue)
                lines.push(`queues["${key}"] selfQueue: ${saved.queues[key].selfQueue} → ${queue.selfQueue}`);
        }
        lines.push(...this.contractDifferences(saved.contractQueues ?? {}, recomputed.contractQueues));
        recomputed.triggers.forEach((trigger: RuntimeTrigger, index: number) =>
            level(`triggers[${index}]`, saved.triggers[index].level, trigger.level),
        );
        if (saved.maxLevel !== recomputed.maxLevel) lines.push(`maxLevel: ${saved.maxLevel} → ${recomputed.maxLevel}`);
        return lines;
    }

    private contractDifferences(saved: Record<string, RuntimeQueueFlow>, recomputed: Record<string, RuntimeQueueFlow>): string[] {
        const lines: string[] = [];
        const fields = (flow: RuntimeQueueFlow | undefined): string =>
            flow === undefined
                ? '(absent)'
                : `L${flow.level} self=${flow.selfQueue} producers=[${flow.producedBy.join(', ')}] consumers=[${flow.consumedBy.join(', ')}]`;
        for (const api of [...new Set([...Object.keys(saved), ...Object.keys(recomputed)])].sort()) {
            const before = fields(saved[api]);
            const after = fields(recomputed[api]);
            if (before !== after) lines.push(`contractQueues["${api}"]: ${before} → ${after}`);
        }
        return lines;
    }

    private missing(): RuleFailError {
        return this.failure(
            `No runtime goal at ${this.goalPath}. Viewing never creates or replaces the goal, and never renders the current graph in its place.`,
            [
                new Option(`Start a proposal from the saved current runtime graph: ${RUNTIME_GOAL_INIT_COMMAND} — then edit the copy and commit it.`, true),
                new Option(`Write ${this.goalPath} by hand in the RuntimeGraph shape of ${DEFAULT_RUNTIME_GRAPH_PATH}.`),
            ],
        );
    }

    private editOption(preferred: boolean): Option {
        return new Option(`Edit ${this.goalPath} by hand — it is a hand-authored proposal, so the fix is in the file, not in source.`, preferred);
    }

    private failure(message: string, options: Option[], cause?: Error): RuleFailError {
        return new RuleFailError(RUNTIME_GOAL_RULE_NAME, message, undefined, undefined, options, undefined, cause);
    }
}

/** What a goal page says it is: a hand-authored proposal, not a generated snapshot (#1239). */
export class RuntimeGoalProvenance {
    message(): string {
        return (
            `Goal / Proposed runtime architecture from ${DEFAULT_RUNTIME_GOAL_PATH}. Hand-authored; not generated from source, ` +
            'and never written by architecture:generate. Viewing changes no file. ' +
            `After editing relationships, recompute derived levels explicitly: ${RUNTIME_GOAL_PREPARE_COMMAND}`
        );
    }

    html(): string {
        return (
            `<p class="hint"><strong>Goal / Proposed runtime architecture.</strong> Hand-authored proposal read from ` +
            `<code>${DEFAULT_RUNTIME_GOAL_PATH}</code>; not generated from source and never written by ` +
            `<code>architecture:generate</code>. Viewing changes no file. After editing relationships, recompute derived ` +
            `levels explicitly: <code>${RUNTIME_GOAL_PREPARE_COMMAND}</code>. Compare with the saved current graph ` +
            `(<code>${DEFAULT_RUNTIME_GRAPH_PATH}</code>) in Color by → Goal vs Current.</p>`
        );
    }
}
