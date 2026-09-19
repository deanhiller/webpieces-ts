import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    HOME_KEY_SINGLE_ROUND_REVIEW, HomeConfigService, ReviewJsonService,
    SINGLE_ROUND_MAIN_AGENT_INSTRUCTIONS, reviewJsonSchemaHint,
} from './index';
import { specTempDirs } from './spec-temp-dirs';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function homeWith(value: unknown): string {
    const home = specTempDirs.make('wp-single-round-home-');
    dirs.push(home);
    fs.mkdirSync(path.join(home, '.webpieces'));
    fs.writeFileSync(path.join(home, '.webpieces', 'config.json'), JSON.stringify({
        [HOME_KEY_SINGLE_ROUND_REVIEW]: value,
    }));
    return home;
}

function reviewWith(instructions?: string): string {
    const dir = specTempDirs.make('wp-single-round-review-');
    dirs.push(dir);
    const file = path.join(dir, 'review.json');
    fs.writeFileSync(file, JSON.stringify({
        title: 'Use one review round', agent: 'codex', model: 'unknown', riskScore: 10,
        riskLevel: 'green', summary: 'Focused single-round review coverage.', violations: [], risks: [],
        filesToReview: [], ...(instructions === undefined ? {} : { main_agent_instructions: instructions }),
    }));
    return file;
}

describe('singleRoundReview home config', () => {
    it('is false when absent or explicitly false, and true only for the top-level opt-in', () => {
        const absent = specTempDirs.make('wp-single-round-absent-');
        dirs.push(absent);
        expect(new HomeConfigService().load(absent).singleRoundReview).toBe(false);
        expect(new HomeConfigService().load(homeWith(false)).singleRoundReview).toBe(false);
        expect(new HomeConfigService().load(homeWith(true)).singleRoundReview).toBe(true);
    });

    it('rejects a non-boolean value and names the top-level key', () => {
        expect(() => new HomeConfigService().load(homeWith('true')))
            .toThrowError(/"singleRoundReview" must be the boolean/);
    });
});

describe('single-round review.json instructions', () => {
    it('omits the field by default and includes the full instruction in single-round mode', () => {
        expect(reviewJsonSchemaHint('/repo/review.json')).not.toContain('main_agent_instructions');
        const hint = reviewJsonSchemaHint('/repo/review.json', SINGLE_ROUND_MAIN_AGENT_INSTRUCTIONS);
        expect(hint).toContain('"main_agent_instructions"');
        expect(hint).toContain('DO NOT RERUN this reviewer');
        expect(hint).toContain('change each addressed red result to yellow');
    });

    it('requires the generated instruction in single-round mode and preserves it when loaded', () => {
        const service = new ReviewJsonService();
        expect(() => service.loadReviewJson(reviewWith(), [], SINGLE_ROUND_MAIN_AGENT_INSTRUCTIONS))
            .toThrowError(/main_agent_instructions/);
        expect(service.loadReviewJson(
            reviewWith(SINGLE_ROUND_MAIN_AGENT_INSTRUCTIONS), [], SINGLE_ROUND_MAIN_AGENT_INSTRUCTIONS)
            .mainAgentInstructions).toBe(SINGLE_ROUND_MAIN_AGENT_INSTRUCTIONS);
    });
});
