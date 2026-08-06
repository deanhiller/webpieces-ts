import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    renderGuaranteeRoot,
    guaranteeRootPath,
    committedGuaranteeRootStale,
    GUARANTEE_ROOT_MARKER,
} from './guarantee-root';

const TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'guarantee-root.sh');

/**
 * The L-1 hook is POSIX sh, so it is tested the only way that proves anything: by RUNNING it against
 * real PreToolUse payloads in a real directory tree. A unit test of a TypeScript string would prove
 * nothing about `sed`, `case` or `cd` behaviour.
 *
 * The tree below reproduces every shape the predicate must tell apart:
 *   proj/                        primary clone            .git DIR   -> ALLOW
 *   proj/repositories/foreign/   nested foreign clone     .git DIR   -> ALLOW (not ours)
 *   proj/.claude/worktrees/wt/   nested linked worktree   .git FILE  -> ALLOW
 *   sibling-wt/                  sibling linked worktree  .git FILE  -> ALLOW
 *   proj/packages/tooling/       ordinary subdirectory    no .git    -> DENY  (sticky + unguarded)
 *   /tmp (outside the project)                                       -> ALLOW (harness resets cwd)
 */
let base = '';
const projOf = (): string => path.join(base, 'proj');

function git(cwd: string, ...args: readonly string[]): void {
    spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

// A verdict from the hook: empty stdout is "no decision -> normal permission flow" (allow).
function verdict(command: string, tool: string = 'Bash'): 'ALLOW' | 'DENY' {
    const payload = JSON.stringify({ tool_name: tool, cwd: projOf(), tool_input: { command } });
    const r = spawnSync('sh', [TEMPLATE], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: projOf() },
    });
    return (r.stdout ?? '').trim() === '' ? 'ALLOW' : 'DENY';
}

function denyPayload(command: string): Record<string, unknown> {
    const payload = JSON.stringify({ tool_name: 'Bash', cwd: projOf(), tool_input: { command } });
    const r = spawnSync('sh', [TEMPLATE], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: projOf() },
    });
    return JSON.parse(r.stdout ?? '{}') as Record<string, unknown>;
}

beforeAll((): void => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-l1-'));
    const proj = projOf();
    for (const d of ['packages/tooling', 'tools', 'repositories/foreign', '.claude/worktrees/wt/sub']) {
        fs.mkdirSync(path.join(proj, d), { recursive: true });
    }
    // core.hooksPath /dev/null: this machine has a global pre-push hook that blocks commits to main.
    for (const repo of [proj, path.join(proj, 'repositories', 'foreign')]) {
        git(repo, 'init', '-q');
        git(repo, 'config', 'core.hooksPath', '/dev/null');
    }
    // A linked worktree's `.git` is a FILE pointing at the shared gitdir — the `-e` test must accept it.
    fs.writeFileSync(path.join(proj, '.claude', 'worktrees', 'wt', '.git'), 'gitdir: /nowhere\n');
    fs.mkdirSync(path.join(base, 'sibling-wt'), { recursive: true });
    fs.writeFileSync(path.join(base, 'sibling-wt', '.git'), 'gitdir: /nowhere\n');
});

afterAll((): void => {
    if (base !== '') fs.rmSync(base, { recursive: true, force: true });
});

describe('guarantee-root.sh is byte-locked to renderGuaranteeRoot()', () => {
    // Same lock as templates/ai-hook.sh vs renderShim(): the file a consumer COMMITS and the file this
    // release EXPECTS must never diverge silently, or every consumer fail-closes on a phantom edit.
    it('matches the template shipped in every release', () => {
        expect(fs.readFileSync(TEMPLATE, 'utf8')).toBe(renderGuaranteeRoot());
    });

    it('is valid POSIX sh', () => {
        expect(spawnSync('sh', ['-n', TEMPLATE], { encoding: 'utf8' }).status).toBe(0);
    });

    it('carries no raw ESC byte (the \\u001b is built at runtime)', () => {
        expect(renderGuaranteeRoot()).not.toContain(String.fromCharCode(0x1b));
    });
});

describe('L-1 allows anything that cannot strand the shell', () => {
    it('allows a command with no cd at all', () => {
        expect(verdict('ls -la')).toBe('ALLOW');
        expect(verdict('git status --short')).toBe('ALLOW');
    });

    it('allows a cd to the primary clone root (.git is a DIRECTORY)', () => {
        expect(verdict(`cd ${projOf()} && ls`)).toBe('ALLOW');
    });

    it('allows a cd into a NESTED linked worktree (.git is a FILE)', () => {
        expect(verdict(`cd ${path.join(projOf(), '.claude/worktrees/wt')} && ls`)).toBe('ALLOW');
    });

    it('allows a cd into a SIBLING linked worktree', () => {
        expect(verdict(`cd ${path.join(base, 'sibling-wt')} && ls`)).toBe('ALLOW');
    });

    // repositories/** is a foreign clone. The relative hooks cannot launch there and we do not WANT
    // them to — so no config read is needed to exempt it; its own .git is the signal.
    it('allows a cd into a nested foreign clone without reading excludePaths', () => {
        expect(verdict(`cd ${path.join(projOf(), 'repositories/foreign')} && ls`)).toBe('ALLOW');
    });

    // Outside the project the harness RESETS the cwd before the next call, so at most one command runs
    // unguarded, on a path we do not govern anyway.
    it('allows a cd outside CLAUDE_PROJECT_DIR', () => {
        expect(verdict('cd /tmp && ls')).toBe('ALLOW');
        expect(verdict(`cd ${base} && ls`)).toBe('ALLOW');
    });

    it('allows a cd to a path that does not exist (the cd itself will fail; shell stays put)', () => {
        expect(verdict(`cd ${path.join(projOf(), 'nope')} && ls`)).toBe('ALLOW');
    });

    it('allows every non-Bash tool — nothing else can move the shell', () => {
        expect(verdict(`cd ${path.join(projOf(), 'tools')} && x`, 'Write')).toBe('ALLOW');
        expect(verdict(`cd ${path.join(projOf(), 'tools')} && x`, 'Read')).toBe('ALLOW');
    });

    // Only a LEADING cd counts, exactly as EffectiveTreeResolver.effectiveCwd() decides it.
    it('ignores a cd that is quoted inside another command', () => {
        expect(verdict(`echo 'cd ${path.join(projOf(), 'tools')} && x'`)).toBe('ALLOW');
    });
});

describe('L-1 denies exactly the sticky-AND-unguarded region', () => {
    it('denies a cd into an ordinary subdirectory of the governed tree', () => {
        expect(verdict(`cd ${path.join(projOf(), 'packages/tooling')} && pnpm test`)).toBe('DENY');
        expect(verdict(`cd ${path.join(projOf(), 'tools')} && ls`)).toBe('DENY');
    });

    it('denies a RELATIVE cd into a subdirectory', () => {
        expect(verdict('cd packages/tooling && pnpm test')).toBe('DENY');
    });

    it('denies a cd into a subdirectory OF A WORKTREE (same hazard, one tree down)', () => {
        expect(verdict(`cd ${path.join(projOf(), '.claude/worktrees/wt/sub')} && x`)).toBe('DENY');
    });

    // A bare `cd` goes to $HOME, where no webpieces hooks exist — every later call would be unguarded.
    it('denies a target it cannot predict', () => {
        expect(verdict('cd')).toBe('DENY');
        expect(verdict('cd -')).toBe('DENY');
    });

    // The guard never expands a shell variable, so it can never judge one. Same rule misplacedCd()
    // already enforces on the TypeScript side.
    it('denies a non-literal target rather than guessing', () => {
        expect(verdict('cd $HOME && ls')).toBe('DENY');
        expect(verdict('cd "$DIR" && ls')).toBe('DENY');
        expect(verdict('cd ~ && ls')).toBe('DENY');
        expect(verdict('cd $(git rev-parse --show-toplevel) && ls')).toBe('DENY');
    });

    it('treats pushd exactly like cd', () => {
        expect(verdict(`pushd ${path.join(projOf(), 'packages')} && ls`)).toBe('DENY');
    });
});

/**
 * REGRESSION — a command containing a DOUBLE QUOTE used to slip through entirely.
 *
 * A JSON payload escapes an embedded quote as `\"`, and the conventional sed form
 * `"command"…"\([^"\\]*\)"` stops at that backslash and yields the EMPTY STRING for the whole command.
 * Empty command read as "no cd here" → ALLOW, so `cd <subdir> && echo "hi"` was completely unguarded —
 * the precise hazard this file exists to close, reachable by adding one quote.
 *
 * The cure is to capture only the PREFIX (no closing quote in the pattern). Everything L-1 needs — the
 * first word and the cd target — is in the prefix; a quote can only appear later.
 *
 * NOTE the same sed form is still used for `CMD` in ai-hook.sh's AUDIT LOG, which is why shim log lines
 * for quoted commands record an empty command column. That is an observability bug, not a guard bug
 * (L0's allowlist fails CLOSED on an empty command), and is tracked separately.
 */
describe('REGRESSION: a double quote must not disable the guard', () => {
    it('still judges the leading cd when the command contains a quoted argument', () => {
        expect(verdict(`cd ${path.join(projOf(), 'tools')} && echo "hi"`)).toBe('DENY');
        expect(verdict(`cd ${projOf()} && echo "hi"`)).toBe('ALLOW');
    });

    it('denies a double-quoted variable target instead of allowing it', () => {
        expect(verdict('cd "$DIR" && ls')).toBe('DENY');
    });

    it('is unaffected by quotes appearing later in a non-cd command', () => {
        expect(verdict('echo "hello world"')).toBe('ALLOW');
    });
});

describe('the deny payload obeys the PreToolUse protocol', () => {
    it('emits deny JSON with a systemMessage, and exits 0', () => {
        const out = denyPayload(`cd ${path.join(projOf(), 'tools')} && ls`);
        const hook = out['hookSpecificOutput'] as Record<string, string>;
        expect(hook['hookEventName']).toBe('PreToolUse');
        // Bash denials: permissionDecisionReason is NOT user-visible, so the red systemMessage carries it.
        expect(hook['permissionDecision']).toBe('deny');
        expect(typeof out['systemMessage']).toBe('string');
    });

    it('names the tree root to cd back to, so the fix is copy-pasteable', () => {
        const out = denyPayload(`cd ${path.join(projOf(), 'tools')} && ls`);
        const hook = out['hookSpecificOutput'] as Record<string, string>;
        expect(hook['permissionDecisionReason']).toContain(projOf());
    });
});

/**
 * H1 is a THIRD writer running in parallel with the guards and rules hooks on every Bash call, so it
 * needs its own file under the same session/agent/hook key LogStream uses — one writer per directory
 * is what makes concurrent appends safe (macOS PIPE_BUF is 512 bytes; real log lines exceed it).
 */
describe('the cd audit log', () => {
    function auditLines(command: string, sessionId: string, agentId: string): readonly string[] {
        const payload = JSON.stringify({
            tool_name: 'Bash', session_id: sessionId, agent_id: agentId,
            cwd: projOf(), tool_input: { command },
        });
        spawnSync('sh', [TEMPLATE], {
            input: payload, encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: projOf() },
        });
        // Flat, same scheme as LogStream.fileName(): <session>-<agent|coordinator>-guarantee-root-<base>
        const who = agentId === '' ? 'coordinator' : agentId;
        const file = path.join(projOf(), '.webpieces', 'logs',
            `${sessionId}-${who}-guarantee-root-cd-audit.log`);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
    }

    it('records a DENY in <session>-<agent>-guarantee-root-cd-audit.log', () => {
        const lines = auditLines(`cd ${path.join(projOf(), 'tools')} && ls`, 'sess-1', 'agent-1');
        expect(lines[lines.length - 1]).toContain('DENY');
        expect(lines[lines.length - 1]).toContain(path.join(projOf(), 'tools'));
    });

    it('records the ALLOWs too, so the audit is a full trail and not just refusals', () => {
        const tree = auditLines(`cd ${projOf()} && ls`, 'sess-2', 'agent-2');
        expect(tree[tree.length - 1]).toContain('ALLOW-GIT-TREE');
        const outside = auditLines('cd /tmp && ls', 'sess-3', 'agent-3');
        expect(outside[outside.length - 1]).toContain('ALLOW-OUTSIDE');
    });

    it('files a coordinator (no agent_id) as -coordinator-, not an empty field', () => {
        expect(auditLines(`cd ${projOf()} && ls`, 'sess-4', '').length).toBeGreaterThan(0);
    });

    // Two concurrent windows must never share a file — that is the whole point of the split.
    // Asserted on FILE IDENTITY rather than accumulated line counts, which a test retry would double.
    it('keeps two sessions in separate files', () => {
        auditLines(`cd ${projOf()} && ls`, 'sess-A', 'agent-x');
        auditLines(`cd ${projOf()} && ls`, 'sess-B', 'agent-x');
        const logs = path.join(projOf(), '.webpieces', 'logs');
        const names = fs.readdirSync(logs).filter((n: string): boolean => n.includes('guarantee-root'));
        expect(names).toContain('sess-A-agent-x-guarantee-root-cd-audit.log');
        expect(names).toContain('sess-B-agent-x-guarantee-root-cd-audit.log');
    });

    it('cannot be walked out of the logs directory by a hostile session id', () => {
        const payload = JSON.stringify({
            tool_name: 'Bash', session_id: '../../../../escaped', agent_id: '',
            cwd: projOf(), tool_input: { command: `cd ${projOf()} && ls` },
        });
        spawnSync('sh', [TEMPLATE], {
            input: payload, encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: projOf() },
        });
        const logs = path.join(projOf(), '.webpieces', 'logs');
        for (const entry of fs.readdirSync(logs)) expect(entry).not.toContain('..');
    });
});

describe('committedGuaranteeRootStale', () => {
    it('is false when the repo has not adopted L-1 yet (no committed file)', () => {
        expect(committedGuaranteeRootStale(projOf())).toBe(false);
    });

    it('is false for a null root — nothing to govern', () => {
        expect(committedGuaranteeRootStale(null)).toBe(false);
    });

    it('is false when the committed copy matches this release', () => {
        const file = guaranteeRootPath(projOf());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, renderGuaranteeRoot());
        expect(committedGuaranteeRootStale(projOf())).toBe(false);
    });

    it('is true when the committed copy was reverted or hand-edited', () => {
        const file = guaranteeRootPath(projOf());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
        expect(committedGuaranteeRootStale(projOf())).toBe(true);
    });

    it('exports the marker path used by the installer and the drift check', () => {
        expect(GUARANTEE_ROOT_MARKER).toBe('.claude/webpieces/guarantee-root.sh');
        expect(guaranteeRootPath('/r')).toBe(path.join('/r', '.claude', 'webpieces', 'guarantee-root.sh'));
    });
});
