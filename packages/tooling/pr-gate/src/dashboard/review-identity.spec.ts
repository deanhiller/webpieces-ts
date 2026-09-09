import { ReviewIdentityRenderer } from './review-identity-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RequiredChecklist, ReviewJsonService } from '@webpieces/rules-config';
import { Dashboard, DashboardInput, DisableCounts } from './dashboard';
import { ChecklistCommentRow } from './checklist-comment-row';
import { ChecklistCommentRenderer } from './checklist-comment-renderer';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function files(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-identity-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({
        title: 'Record review identity', agent: 'codex', model: 'unknown', riskScore: 10, riskLevel: 'green',
    }));
    fs.writeFileSync(path.join(dir, 'review-api.json'), JSON.stringify({
        id: 'api', status: 'green', output: 'Checked API', agent: 'claude', model: 'opus',
    }));
    return dir;
}

const required = [new RequiredChecklist('api', 'api', '', ['api.ts'])];
const service = new ReviewJsonService();

describe('review identity from JSON to PR comments', () => {
    it('renders identity as plain text without allowing forged headings or HTML markers', () => {
        const rendered = new ReviewIdentityRenderer().render('claude\n## forged', '<!-- marker --> [opus](https://example.com)');
        expect(rendered).not.toContain('\n');
        expect(rendered).not.toContain('<!--');
        expect(rendered).not.toContain('[opus](');
        expect(rendered).toContain('claude &#35;&#35; forged');
    });
    it('preserves distinct author/reviewer identities and publishes them without claiming provenance', () => {
        const dir = files();
        const review = service.loadReviewJson(path.join(dir, 'review.json'), required);
        expect([review.agent, review.model]).toEqual(['codex', 'unknown']);
        const verdict = review.results[0];
        expect([verdict.agent, verdict.model]).toEqual(['claude', 'opus']);
        const dashboard = new Dashboard().renderDetailComment(new DashboardInput(
            review.title, [], new DisableCounts(0, 0, []), true, 'base', 'head', 'merge', review, [], 'pnpm wp-build', 0,
        ));
        expect(dashboard).toContain('**Review agent:** codex · **Model:** unknown (self-reported)');
        const row = new ChecklistCommentRow(verdict.agent, verdict.model, verdict.id, 'PASS', verdict.output,
            true, [], [], ['api.ts'], 1);
        const comment = new ChecklistCommentRenderer().render([row], false, true, 0);
        expect(comment).toContain('**Agent:** claude · **Model:** opus (self-reported)');
        expect(comment).toContain('provenance was NOT verified');
    });

    for (const name of ['review.json', 'review-api.json']) {
        for (const field of ['agent', 'model']) {
            it.each([undefined, null, 42, {}, [], '', '   '])(`rejects invalid ${field} in ${name}: %j`, value => {
                const dir = files();
                const file = path.join(dir, name);
                const json = JSON.parse(fs.readFileSync(file, 'utf8'));
                json[field] = value;
                fs.writeFileSync(file, JSON.stringify(json));
                expect(() => service.loadReviewJson(path.join(dir, 'review.json'), required)).toThrow(/non-empty string/);
            });
        }
    }

    it('teaches required identity and unknown in the generated main and reviewer schemas', () => {
        expect(service.reviewJsonSchemaHint('/review.json')).toContain('"agent"');
        expect(service.reviewJsonSchemaHint('/review.json')).toContain('"model"');
        const schema = service.verdictSchemaFor('api');
        expect(schema).toContain('REQUIRED non-empty strings');
        expect(schema).toContain('never the parent');
        expect(schema).toContain('literal "unknown"');
    });
});
