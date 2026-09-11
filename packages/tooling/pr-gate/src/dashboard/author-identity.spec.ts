import { afterEach, describe, expect, it } from 'vitest';
import { ReviewJson } from '@webpieces/rules-config';
import { AuthorIdentityResolver } from './author-identity';
import { Dashboard, DashboardInput } from './dashboard';

const savedClaudeSession = process.env['CLAUDE_CODE_SESSION_ID'];
const savedCodexSession = process.env['CODEX_SESSION_ID'];
const savedCodexThread = process.env['CODEX_THREAD_ID'];

afterEach(() => {
    restore('CLAUDE_CODE_SESSION_ID', savedClaudeSession);
    restore('CODEX_SESSION_ID', savedCodexSession);
    restore('CODEX_THREAD_ID', savedCodexThread);
});

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function harness(claude: boolean, codex: boolean): void {
    restore('CLAUDE_CODE_SESSION_ID', claude ? 'claude-session' : undefined);
    restore('CODEX_SESSION_ID', codex ? 'codex-session' : undefined);
    delete process.env['CODEX_THREAD_ID'];
}

function rendered(model: string): { body: string; dashboard: string } {
    const renderer = new Dashboard();
    const review = new ReviewJson(
        'self-report-is-not-used-for-harness',
        model,
        'Title',
        10,
        'green',
        '🟢',
        'Summary.',
        [],
        [],
        [],
    );
    const input = new DashboardInput(
        'Title',
        [],
        renderer.countAddedDisables(''),
        true,
        'base',
        'head',
        'main',
        review,
        [],
        'pnpm wp-build',
        0,
        new AuthorIdentityResolver().resolve(review.model),
    );
    return {
        body: renderer.renderPrBody(input, ''),
        dashboard: renderer.renderDetailComment(input),
    };
}

describe('author identity rendered into the permanent body and first-comment dashboard', () => {
    it('renders Claude Code from the harness-owned session id and the self-reported model', () => {
        harness(true, false);
        const output = rendered('claude-opus-5');

        expect(output.body).toContain(
            'Author agent: claude-code (detected) · Model: claude-opus-5 (self-reported)',
        );
        expect(output.dashboard).toContain(
            '**Author agent:** claude-code (detected) · **Model:** claude-opus-5 (self-reported)',
        );
    });

    it('renders Codex from the harness-owned session id and the self-reported model', () => {
        harness(false, true);
        const output = rendered('gpt-5.6-sol');

        expect(output.body).toContain(
            'Author agent: codex (detected) · Model: gpt-5.6-sol (self-reported)',
        );
        expect(output.dashboard).toContain(
            '**Author agent:** codex (detected) · **Model:** gpt-5.6-sol (self-reported)',
        );
    });

    it('renders honest unknowns when neither source knows the identity', () => {
        harness(false, false);
        expect(rendered('').body).toContain(
            'Author agent: unknown (detected) · Model: unknown (self-reported)',
        );
    });

    it('does not guess when both harness session identifiers are present', () => {
        harness(true, true);
        expect(rendered('some-model').body).toContain('Author agent: unknown (detected)');
    });
});
