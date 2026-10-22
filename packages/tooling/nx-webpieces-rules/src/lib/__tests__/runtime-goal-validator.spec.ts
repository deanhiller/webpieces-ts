import { describe, expect, it } from 'vitest';
import { RuntimeGoalValidator } from '../runtime-goal-validator';
import { RuntimeGoalFile } from '../runtime-goal-file';
import { RuntimeGoalFixture } from './runtime-goal-fixture';

const GOAL = 'architecture/runtime-dependencies-goal.json';

describe('RuntimeGoalValidator — hand-authored goal shape and references (#1239)', () => {
    const validator = new RuntimeGoalValidator(GOAL);

    it('accepts a levelled goal with proposed services absent from source', () => {
        const goal = new RuntimeGoalFixture().goal;
        expect(validator.structural(goal)).toEqual([]);
        expect(validator.derived(goal)).toEqual([]);
    });

    it('rejects a non-object or a wrong shape, naming the goal path', () => {
        expect(validator.structural([])).toEqual([`${GOAL} must contain a JSON object (a RuntimeGraph).`]);
        expect(validator.structural({ services: {} })).toEqual(expect.arrayContaining([`${GOAL}: "runtimeEdges" must be an array.`]));
    });

    it('separates broken references (edit the file) from missing derived facts (--prepare-goal computes them)', () => {
        const goal = RuntimeGoalFixture.copy(new RuntimeGoalFixture().goal);
        goal.runtimeEdges.push({ from: 'billing', to: 'ledger', via: ['LedgerApi'], type: 'rpc' });
        goal.runtimeEdges.push({ from: 'billing', to: 'ai-chat', via: ['ChatApi'], type: 'pubsub', queue: 'ChatApi.send' });
        goal.triggers[0].service = 'gone';
        goal.contractQueues['PublicWebhooksApi'].producedBy.push('nobody');
        const structural = validator.structural(goal).join('\n');
        expect(structural).toContain(`names 'ledger', which is not in "services". Add services["ledger"] or remove the edge.`);
        expect(structural).toContain(`flows through queue 'ChatApi.send', which is not in "queues"`);
        expect(structural).toContain(`${GOAL}: triggers[0] targets 'gone'`);
        expect(structural).toContain(`contractQueues["PublicWebhooksApi"].producedBy names 'nobody'`);
        expect(structural).not.toContain('architecture:generate');

        const derivedOnly = RuntimeGoalFixture.copy(new RuntimeGoalFixture().goal);
        derivedOnly.runtimeEdges.push({ from: 'billing', to: 'ai-chat', via: ['NewQueueApi'], type: 'pubsub' });
        derivedOnly.services['billing'].level = -1;
        expect(validator.structural(derivedOnly)).toEqual([]);
        const derived = validator.derived(derivedOnly).join('\n');
        expect(derived).toContain('contractQueues["NewQueueApi"] is missing.');
        expect(derived).toContain(`${GOAL}: services["billing"] needs an integer "level" >= 0`);
    });

    it('reports derived-fact drift, and a cycle separately with an edit (never --prepare-goal) cure', () => {
        const goal = RuntimeGoalFixture.copy(new RuntimeGoalFixture().goal);
        goal.services['billing'].level = 7;
        const file = new RuntimeGoalFile();
        expect(file.drift(goal).cycle).toBeNull();
        expect(file.drift(goal).differences).toContain('services["billing"] level: L7 → L2');
        goal.runtimeEdges.push({ from: 'pg-dataaccess', to: 'billing', via: ['LoopApi'], type: 'rpc' });
        const drift = file.drift(goal);
        expect(drift.cycle).toContain(`${GOAL} describes a runtime graph the level machinery cannot order`);
        expect(drift.differences).toEqual([]);
        expect(file.cycleOption().text).toContain('runtimeEdges');
        expect(file.cycleOption().text).not.toContain('--prepare-goal');
    });
});
