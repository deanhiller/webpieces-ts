import { extractPrBody } from './pr-creation-guard';

const ROOT = '/repo';
const PHRASE = 'I ran pnpm nx affected --target=ci and all checks passed';

describe('extractPrBody', () => {
    it('extracts a simple double-quoted inline body', () => {
        const cmd = `gh pr create --title "x" --body "${PHRASE}"`;
        expect(extractPrBody(cmd, ROOT)).toBe(PHRASE);
    });

    it('captures a multi-line heredoc body containing embedded double quotes', () => {
        // Regression: the old non-greedy regex stopped at the first embedded quote
        // ("not installed") and dropped the CI phrase that appears later in the body.
        const cmd = [
            'gh pr create --title "x" --body "$(cat <<\'EOF\'',
            '## Problem',
            'It wrongly reported webpieces as "not installed" and blocked.',
            '',
            `${PHRASE}`,
            'EOF',
            ')"',
        ].join('\n');
        const body = extractPrBody(cmd, ROOT);
        expect(body).not.toBeNull();
        expect(body).toContain(PHRASE);
        expect(body).toContain('"not installed"');
    });

    it('extracts a single-quoted inline body', () => {
        const cmd = `gh pr create --body '${PHRASE}'`;
        expect(extractPrBody(cmd, ROOT)).toBe(PHRASE);
    });

    it('returns null when no body flag is present', () => {
        expect(extractPrBody('gh pr create --title "x"', ROOT)).toBeNull();
    });
});
