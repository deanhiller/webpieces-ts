import { describe, it, expect } from 'vitest';
import { CommandScanner } from './command-scan';

const scanner = new CommandScanner();
const commandSegments = (cmd: string): readonly string[] => scanner.commandSegments(cmd);
const gitSubcommand = (seg: string): string | null => scanner.gitSubcommand(seg);
const invokesGit = (seg: string, sub: string): boolean => scanner.invokesGit(seg, sub);
const commandInvokesGit = (cmd: string, sub: string): boolean => scanner.commandInvokesAnyGit(cmd, [sub]);

describe('commandSegments', () => {
    it('splits on every shell separator', () => {
        expect(commandSegments('git checkout feat && git rebase main'))
            .toEqual(['git checkout feat', 'git rebase main']);
        expect(commandSegments('git switch feat; git merge main'))
            .toEqual(['git switch feat', 'git merge main']);
        expect(commandSegments('a || b')).toEqual(['a', 'b']);
        expect(commandSegments('a | b')).toEqual(['a', 'b']);
        expect(commandSegments('a\nb')).toEqual(['a', 'b']);
    });

    it('treats quoted separators as literal text', () => {
        expect(commandSegments('git commit -m "fix; ship it"'))
            .toEqual(['git commit -m "fix; ship it"']);
        expect(commandSegments("echo 'a && b'")).toEqual(["echo 'a && b'"]);
    });

    it('splits command substitution out into its own segment', () => {
        // So a git invocation can never hide inside $(...).
        expect(commandSegments('pnpm nx affected --base=$(git merge-base origin/main HEAD)'))
            .toEqual(['pnpm nx affected --base=$', 'git merge-base origin/main HEAD']);
    });
});

describe('gitSubcommand', () => {
    it('returns the subcommand as an exact token', () => {
        expect(gitSubcommand('git merge main')).toBe('merge');
        expect(gitSubcommand('git rebase origin/main')).toBe('rebase');
        // The whole point: merge-base is NOT merge.
        expect(gitSubcommand('git merge-base origin/main HEAD')).toBe('merge-base');
    });

    it('skips git global flags to find the subcommand', () => {
        expect(gitSubcommand('git -C /some/path merge main')).toBe('merge');
        expect(gitSubcommand('git -c user.name=x merge main')).toBe('merge');
        expect(gitSubcommand('git --no-pager log')).toBe('log');
        expect(gitSubcommand('git --git-dir=/x/.git merge main')).toBe('merge');
    });

    it('skips wrappers and env assignments', () => {
        expect(gitSubcommand('sudo git merge main')).toBe('merge');
        expect(gitSubcommand('GIT_DIR=/x git merge main')).toBe('merge');
    });

    it('returns null when git is not actually invoked', () => {
        expect(gitSubcommand('pnpm wp-start-update')).toBeNull();
        expect(gitSubcommand('')).toBeNull();
        expect(gitSubcommand('git')).toBeNull();
    });
});

describe('invokesGit / commandInvokesGit', () => {
    it('matches a real invocation in any segment', () => {
        expect(invokesGit('git merge main', 'merge')).toBe(true);
        expect(commandInvokesGit('git checkout feat && git rebase main', 'rebase')).toBe(true);
        expect(commandInvokesGit('git branch -D old && git checkout feat && git rebase main', 'rebase')).toBe(true);
    });

    it('does NOT match merge-base — it is read-only and in the documented build command', () => {
        expect(invokesGit('git merge-base origin/main HEAD', 'merge')).toBe(false);
        expect(commandInvokesGit('pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)', 'merge')).toBe(false);
    });

    it('does NOT match a mere mention in a read-only command', () => {
        expect(commandInvokesGit("grep 'git rebase main' notes.md", 'rebase')).toBe(false);
        expect(commandInvokesGit('echo "git merge main"', 'merge')).toBe(false);
        expect(commandInvokesGit("rg 'git merge' packages/", 'merge')).toBe(false);
        expect(commandInvokesGit('cat docs/git-merge-notes.md', 'merge')).toBe(false);
    });

    it('does not confuse one git subcommand for another', () => {
        expect(invokesGit('git commit -m "merge main"', 'merge')).toBe(false);
        expect(invokesGit('git log --oneline -5', 'merge')).toBe(false);
    });
});

/**
 * `2>&1` is the single most common decoration an agent appends to a command. Splitting on its `&`
 * tore `git fetch origin main 2>&1 | tail -5` into THREE segments — `git fetch … 2>`, a bare `1`, and
 * `tail -5` — and a bare `1` is on nobody's allowlist, so every guard that requires ALL segments to
 * pass denied a command whose own remedy block had printed it.
 */
describe('commandSegments — redirections are not separators', () => {
    it('keeps `2>&1` inside its segment', () => {
        expect(commandSegments('git fetch origin main 2>&1'))
            .toEqual(['git fetch origin main 2>&1']);
        expect(commandSegments('git fetch origin main 2>&1 | tail -5'))
            .toEqual(['git fetch origin main 2>&1', 'tail -5']);
        expect(commandSegments('pnpm wp-cleanup 2>&1 | tail -40'))
            .toEqual(['pnpm wp-cleanup 2>&1', 'tail -40']);
        expect(commandSegments('cmd 1>&2')).toEqual(['cmd 1>&2']);
        expect(commandSegments('cmd &> out.log')).toEqual(['cmd &> out.log']);
    });

    it('still splits a real background `&` and a real `&&`', () => {
        expect(commandSegments('server start & tail -f log')).toEqual(['server start', 'tail -f log']);
        expect(commandSegments('git fetch origin main && git status'))
            .toEqual(['git fetch origin main', 'git status']);
    });
});

describe('gitSubcommandOf — words already extracted by a caller', () => {
    it('resolves the subcommand from a words array', () => {
        expect(scanner.gitSubcommandOf(['git', 'status'])).toBe('status');
        expect(scanner.gitSubcommandOf(['git', '-C', '/repo', 'merge', 'main'])).toBe('merge');
        expect(scanner.gitSubcommandOf(['pnpm', 'build'])).toBe(null);
        expect(scanner.gitSubcommandOf([])).toBe(null);
    });
});

describe('gitSubcommandArgs — the tokens AFTER the subcommand', () => {
    it('returns the arguments, with wrappers and git global flags already consumed', () => {
        expect(scanner.gitSubcommandArgs('git commit -m msg', 'commit')).toEqual(['-m', 'msg']);
        expect(scanner.gitSubcommandArgs('sudo git commit -am msg', 'commit')).toEqual(['-am', 'msg']);
        expect(scanner.gitSubcommandArgs('git -C /some/path commit -m msg', 'commit')).toEqual(['-m', 'msg']);
        expect(scanner.gitSubcommandArgs('GIT_AUTHOR_NAME=x git commit --amend', 'commit')).toEqual(['--amend']);
    });

    it('keeps a quoted argument as ONE token holding its literal text', () => {
        expect(scanner.gitSubcommandArgs('git commit -m "two words"', 'commit')).toEqual(['-m', 'two words']);
        expect(scanner.gitSubcommandArgs('git commit -m "line\nline"', 'commit')).toEqual(['-m', 'line\nline']);
    });

    it('is null for a different subcommand, a different program, or a mere mention', () => {
        expect(scanner.gitSubcommandArgs('git merge-base origin/main HEAD', 'commit')).toBeNull();
        expect(scanner.gitSubcommandArgs('echo "git commit -m x"', 'commit')).toBeNull();
        expect(scanner.gitSubcommandArgs('git', 'commit')).toBeNull();
        expect(scanner.gitSubcommandArgs('', 'commit')).toBeNull();
    });

    it('is an EMPTY array, not null, for the subcommand with no arguments', () => {
        expect(scanner.gitSubcommandArgs('git commit', 'commit')).toEqual([]);
    });
});
