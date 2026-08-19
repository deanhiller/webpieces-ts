import { describe, it, expect, vi } from 'vitest';

// The decision log writes to disk; silence it so these tests never touch the fs. MATRIX_L2_UNROWED is a
// real value the guard passes through, so it is re-exported from the original rather than stubbed.
type DecisionLogModule = typeof import('../decision-log');
vi.mock('../decision-log', async (importActual: () => Promise<DecisionLogModule>) => {
    const actual = await importActual();
    return {
        ...actual,
        logGuardDecision: (): void => undefined,
    };
});

import { Option } from '@webpieces/rules-config';

import { BashContext } from '../types';
import { CommitMessageSubstitutionGuardRule } from './commit-message-substitution-guard';

function guard(): CommitMessageSubstitutionGuardRule {
    return new CommitMessageSubstitutionGuardRule();
}

function blocked(command: string): boolean {
    return guard().check(new BashContext(command, '/repo')).length === 1;
}

function messageFor(command: string): string {
    const violations = guard().check(new BashContext(command, '/repo'));
    expect(violations).toHaveLength(1);
    return violations[0].message ?? '';
}

// The real incident, trimmed to the sentence that hung: `strings` ran with no arguments, read stdin,
// and never returned. Ten minutes to SIGTERM, twice.
const INCIDENT = 'git commit -q -m "One cross-platform Metro URL for the shell\n' +
    'RCTDefines.h consumed at COMPILE time, and `strings` on a .app built with\n' +
    '--port 8084 contains no 8084."';

describe('commit-message-substitution-guard blocks an inline message the shell would expand', () => {
    it('blocks the incident command itself', () => {
        expect(blocked(INCIDENT)).toBe(true);
    });

    it('blocks a backtick in the message', () => {
        expect(blocked('git commit -m "fix the `strings` call"')).toBe(true);
    });

    it('blocks $( in the message', () => {
        expect(blocked('git commit -m "pin it to $(git rev-parse HEAD)"')).toBe(true);
    });

    it('blocks a newline inside the message, which is where backticks hide', () => {
        expect(blocked('git commit -m "subject line\n\nand a body paragraph"')).toBe(true);
    });

    it('blocks every spelling of the message flag', () => {
        expect(blocked('git commit -am "touch `x`"')).toBe(true);
        expect(blocked('git commit -qam "touch `x`"')).toBe(true);
        expect(blocked('git commit --message "touch `x`"')).toBe(true);
        expect(blocked('git commit --message="touch `x`"')).toBe(true);
        expect(blocked('git commit -m"touch `x`"')).toBe(true);
        expect(blocked('git commit -am"touch `x`"')).toBe(true);
    });

    // The tokenizer already knows about wrappers and git's own global flags; the guard must inherit
    // that rather than re-deriving it, or every one of these is a labelled side door.
    it('resolves git through wrappers and global flags', () => {
        expect(blocked('sudo git commit -m "touch `x`"')).toBe(true);
        expect(blocked('git -C /some/path commit -m "touch `x`"')).toBe(true);
        expect(blocked('env GIT_AUTHOR_NAME=x git commit -m "touch `x`"')).toBe(true);
    });

    it('blocks the commit half of a chain, wherever it sits', () => {
        expect(blocked('git add -A && git commit -m "touch `x`"')).toBe(true);
        expect(blocked('git commit -m "touch `x`" 2>&1 | tail -5')).toBe(true);
    });

    /*
     * A DELIBERATE false positive — see the guard's docstring. Single quotes really do suppress
     * substitution, so this exact command is safe as written. It is blocked anyway because prose
     * eventually contains an apostrophe, which closes the quote mid-sentence and drops the rest back
     * into the shell's syntax; and because `-F` costs one Write call, so being wrong here is seconds
     * against the twenty minutes being right saves.
     *
     * This test exists so the decision is met as a failing test rather than filed as a bug.
     */
    it('blocks a single-quoted message too, on purpose', () => {
        expect(blocked("git commit -m 'a `backtick` here'")).toBe(true);
        expect(blocked("git commit -m 'a $(substitution) here'")).toBe(true);
        expect(blocked("git commit -m 'subject\nbody'")).toBe(true);
    });

    // The incident's SECOND failure: the retry kept the same sentence. A guard that only fired on the
    // first attempt would have cost the same twenty minutes.
    it('fires again on a retry of the same command', () => {
        expect(blocked(INCIDENT)).toBe(true);
        expect(blocked(INCIDENT)).toBe(true);
    });
});

describe('what it must NOT touch', () => {
    it('allows a plain single-line message', () => {
        expect(blocked('git commit -m "fix the parser"')).toBe(false);
        expect(blocked('git commit -am "fix the parser"')).toBe(false);
        expect(blocked("git commit -m 'fix the parser'")).toBe(false);
    });

    it('allows every message form that keeps the text out of the shell', () => {
        expect(blocked('git commit -F /tmp/commit-msg.txt')).toBe(false);
        expect(blocked('git commit --file=/tmp/commit-msg.txt')).toBe(false);
        expect(blocked('git commit -C HEAD')).toBe(false);
        expect(blocked('git commit --reuse-message=HEAD')).toBe(false);
        expect(blocked('git commit --amend --no-edit')).toBe(false);
        expect(blocked('git commit')).toBe(false);
    });

    // The whole cure, exercised: a heredoc body stuffed with backticks and command names must pass, or
    // the guard blocks its own remedy and wedges the session.
    it('allows -F - with a QUOTED heredoc whose body is full of backticks', () => {
        const command = "git commit -F - <<'EOF'\n" +
            'Fix the shell hang\n\n' +
            'The `strings` call and $(git rev-parse HEAD) are prose here, not syntax.\n' +
            'Also mentions pnpm run build-all and gh pr merge.\n' +
            'EOF';
        expect(blocked(command)).toBe(false);
    });

    it('allows a plain && chain with no inline message', () => {
        expect(blocked('git add -A && git commit -F /tmp/msg.txt && git push')).toBe(false);
    });

    // A newline SEPARATING commands is not a newline INSIDE a message.
    it('allows a multi-line script whose commit message is single-line', () => {
        expect(blocked('git add -A\ngit commit -m "fix the parser"\ngit status')).toBe(false);
    });

    it('ignores a commit command that is only MENTIONED', () => {
        expect(blocked('echo "git commit -m \\"touch `x`\\""')).toBe(false);
        expect(blocked('grep -rn "git commit -m" docs/')).toBe(false);
    });

    it('leaves other git subcommands alone', () => {
        expect(blocked('git tag -m "annotated `x`" v1')).toBe(false);
        expect(blocked('git stash push -m "wip `x`"')).toBe(false);
    });
});

describe('the refusal teaches the -F cure', () => {
    it('names git commit -F in the violation message', () => {
        const message = messageFor('git commit -m "fix the `strings` call"');
        expect(message).toContain('git commit -F <file>');
        expect(message).toContain('Write tool');
    });

    it('quotes the offending span so the agent can see WHICH character', () => {
        expect(messageFor('git commit -m "fix the `strings` call"')).toContain('`strings`');
        expect(messageFor('git commit -m "pin $(git rev-parse HEAD)"')).toContain('$(git rev-parse HEAD)');
    });

    it('renders a newline in the excerpt as \\n so the refusal stays readable', () => {
        expect(messageFor('git commit -m "subject\nbody"')).toContain('subject\\nbody');
    });

    it('names the flag that carried the message', () => {
        expect(messageFor('git commit -am "touch `x`"')).toContain('-am');
        expect(messageFor('git commit --message "touch `x`"')).toContain('--message');
    });

    // The framework owns "Fix Option N:" numbering (report.ts), so the cures are Options, never
    // hand-numbered prose in a string literal.
    it('offers both accepted spellings as fix options, file-first', () => {
        const hint = guard().fixHint;
        expect(hint.fixOptions).toHaveLength(2);
        expect(hint.fixOptions[0].preferred).toBe(true);
        expect(hint.fixOptions[0].text).toContain('git commit -F /tmp/commit-msg.txt');
        expect(hint.fixOptions[1].text).toContain("git commit -F - <<'EOF'");
        for (const option of hint.fixOptions) {
            expect(option, 'the framework numbers options; a rule never does').toBeInstanceOf(Option);
            expect(option.text).not.toMatch(/Fix Option/);
        }
    });

    // The quoting is the entire mechanism, and an unquoted <<EOF still expands. A cure that half-works
    // is worse than none, so the guard says so out loud.
    it('says the heredoc delimiter must be QUOTED', () => {
        expect(guard().fixHint.fixOptions[1].text).toContain('unquoted <<EOF does NOT');
    });
});
