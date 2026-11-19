"""Guards the multi-account Claude config-dir lookup (issue #1439).

A machine can run several Claude Code accounts (`~/.claude`, `~/.claude-work`, selected with
CLAUDE_CONFIG_DIR). The audit once read only `~/.claude/projects`, so a run from the other account
scanned nothing and reported CLEAN. `claude_config_roots()` must return every root, deduplicated
by realpath, and the transcript readers must see every root's sessions exactly once.

Temp dirs with HOME and CLAUDE_CONFIG_DIR pointed at them — never the real home.
"""
import importlib.util
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('wp', os.path.join(HERE, 'wp_audit.py'))
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

failures = 0


def check(name, got, want):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print('%s %s%s' % ('ok  ' if ok else 'FAIL', name, '' if ok else '  got=%r want=%r' % (got, want)))


def with_env(home, config_dir):
    """Point HOME / CLAUDE_CONFIG_DIR at the fixture and drop the cached roots."""
    os.environ['HOME'] = str(home)
    if config_dir is None:
        os.environ.pop('CLAUDE_CONFIG_DIR', None)
    else:
        os.environ['CLAUDE_CONFIG_DIR'] = str(config_dir)
    wp.CONFIG_ROOTS = None


def session(projects, repo, sid, agent=None):
    d = projects / wp.sanitized(repo)
    d.mkdir(parents=True, exist_ok=True)
    (d / (sid + '.jsonl')).write_text('{}\n')
    if agent:
        sub = d / sid / wp.SUBAGENT_DIR
        sub.mkdir(parents=True, exist_ok=True)
        (sub / (agent + '.jsonl')).write_text('{}\n')
        (sub / (agent + '.meta.json')).write_text('{"agentType": "general-purpose"}')


def main():
    saved = {k: os.environ.get(k) for k in ('HOME', 'CLAUDE_CONFIG_DIR')}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            repo = Path('/fake/repo')
            claude = home / '.claude'
            work = home / '.claude-work'
            # one session in each account, under the SAME project dir name
            session(claude / 'projects', repo, 'sess-a', agent='agent-a')
            session(work / 'projects', repo, 'sess-b', agent='agent-b')
            (claude / 'CLAUDE.md').write_text('user doc a\n')
            (work / 'skills' / 'x').mkdir(parents=True)
            (work / 'skills' / 'x' / 'SKILL.md').write_text('skill b\n')
            # a ~/.claude-* with no projects/ is not a config root
            (home / '.claude-cache').mkdir()

            # 1. two roots unioned, even with CLAUDE_CONFIG_DIR unset
            with_env(home, None)
            check('two roots unioned', [r.name for r in wp.config_roots()], ['.claude', '.claude-work'])
            dirs = wp.transcript_dirs_for(repo)
            check('same project dir name in both roots kept', len(dirs), 2)
            sids = sorted(f.stem for d in dirs for f in d.glob('*.jsonl'))
            check('sessions from both roots, once each', sids, ['sess-a', 'sess-b'])
            since = datetime.now(timezone.utc) - timedelta(hours=1)
            subs = sorted((p, a) for p, a, _m, _f in wp.subagent_files_for(repo, since))
            check('subagents from both roots', subs, [('sess-a', 'agent-a'), ('sess-b', 'agent-b')])

            # 2. CLAUDE_CONFIG_DIR == ~/.claude (spelled differently) is deduplicated
            with_env(home, str(home) + '/./.claude/')
            check('dedup CLAUDE_CONFIG_DIR == ~/.claude', len(wp.config_roots()), 2)
            check('no double-counted sessions', len(wp.transcript_dirs_for(repo)), 2)

            # 2b. a symlinked root is deduplicated by realpath
            (home / '.claude-alias').symlink_to(work)
            with_env(home, None)
            check('dedup symlinked root', len(wp.config_roots()), 2)
            (home / '.claude-alias').unlink()

            # 3. CLAUDE_CONFIG_DIR elsewhere is added first; a missing dir is skipped
            other = home / 'elsewhere'
            session(other / 'projects', repo, 'sess-c')
            with_env(home, other)
            check('CLAUDE_CONFIG_DIR outside home added first',
                  [r.name for r in wp.config_roots()], ['elsewhere', '.claude', '.claude-work'])
            with_env(home, home / 'does-not-exist')
            check('missing CLAUDE_CONFIG_DIR skipped',
                  [r.name for r in wp.config_roots()], ['.claude', '.claude-work'])
            import shutil
            shutil.rmtree(claude)
            with_env(home, None)
            check('missing ~/.claude skipped', [r.name for r in wp.config_roots()], ['.claude-work'])
            with_env(home / 'empty-home', None)
            check('no roots at all -> empty, not a crash', wp.config_roots(), [])
            check('no roots -> no transcript dirs', wp.transcript_dirs_for(repo), [])
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        wp.CONFIG_ROOTS = None
    print('FAILURES:', failures)
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
