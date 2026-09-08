"""Guards `counts_as_await_use()` — the adoption counter for the `waits` subcommand.

Why this test exists: a naive `'wp-await' in cmd` substring check over one real 24h window returned
19 "adoptions" of which ZERO were uses. Eleven were the agents BUILDING the command — greps,
`vitest run await-reviews-command.spec.ts`, commit messages naming it — and the rest were setup.
An adoption counter that counts its own implementation reports success on the day the feature
shipped, which is worse than having no counter at all.

Bias note: the matcher deliberately MISSES the `VAR=/path/wp-await.sh; $VAR …` idiom. Under-counting
adoption makes the fix look worse than it is, which is the safe direction for a metric whose whole
job is to say whether the fix worked.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('wp', os.path.join(HERE, 'wp_audit.py'))
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

CASES = [
    # real invocations
    ("~/.claude/skills/full-cycle/scripts/wp-await.sh --run 'gh pr checks 1174'", True),
    ("pnpm wp-await-reviews", True),
    ("pnpm wp-await-checks --pr 879", True),
    ("cd /x && ~/.claude/skills/full-cycle/scripts/wp-await.sh --run 'x' --until y", True),
    ("bash scripts/wp-await.sh --run 'x' --until y", True),
    # mentions — every one of these is a real line that fooled the substring version
    (r'grep -rln "wp-await\|wait-spin" --include=*.ts .', False),
    ("grep -rn 'wp-await-reviews' . --include=*.ts -l", False),
    ("cd /x/packages/tooling/pr-gate && pnpm exec vitest run "
     "src/scripts/commands/await-reviews-command.spec.ts", False),
    ("git commit -q -F - <<'EOF' Add wp-await-reviews / wp-await-checks and wait-spin-guard", False),
    ("chmod +x /Users/d/.claude/skills/full-cycle/scripts/wp-await.sh", False),
    ("cat > /tmp/x.py <<'EOF' wp-await stuff", False),
    ("python3 /tmp/patch.py  # touches wp-await", False),
    ("ls -la ~/.claude/skills/full-cycle/scripts/wp-await.sh", False),
    # unrelated
    ("gh pr checks 879", False),
    ("echo .", False),
]

# Documented, deliberate miss — see the bias note above.
KNOWN_MISSES = ["S=/path/wp-await.sh $S --run 'x' --until y"]


def main():
    failures = 0
    for cmd, want in CASES:
        got = wp.counts_as_await_use(cmd)
        if got != want:
            failures += 1
            print('FAIL want=%-5s got=%-5s | %s' % (want, got, cmd[:86]))
        else:
            print('ok   want=%-5s | %s' % (want, cmd[:86]))
    for cmd in KNOWN_MISSES:
        state = ('still missed (expected)' if not wp.counts_as_await_use(cmd)
                 else 'NOW CAUGHT — tighten this test')
        print('note %-23s | %s' % (state, cmd[:86]))
    print('FAILURES: %d' % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
