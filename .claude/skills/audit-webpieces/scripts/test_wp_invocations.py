"""Guards `wp_invocations()` — the counter that separates a real `wp-*` invocation from a
grep, a ps line, or prose naming the command. A bare substring search once inflated an audit's
Codex figure from 7 to 92, so this test is the thing standing between that and a headline."""
import importlib.util
spec = importlib.util.spec_from_file_location('wp', '.claude/skills/audit-webpieces/scripts/wp_audit.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cases = [
    ('pnpm wp-review-upsert-pr', 1),
    ('ps -ax | rg wp-review-upsert-pr', 0),
    ('grep -rn wp-review-upsert-pr .', 0),
    ('{"cmd":"pnpm wp-review-upsert-pr","workdir":"/x"}', 1),
    ('"prefix_rule":["pnpm","wp-review-upsert-pr"]', 0),
    ('cd /x && pnpm wp-review-upsert-pr', 1),
    ('pnpm wp-review-upsert-pr && pnpm wp-finish-upsert-pr', 1),
]
bad = 0
for cmd, want in cases:
    got = m.wp_invocations(cmd).get('wp-review-upsert-pr', 0)
    ok = 'ok ' if got == want else 'FAIL'
    if got != want:
        bad += 1
    print('%s want=%d got=%d | %s' % (ok, want, got, cmd))
print('FAILURES:', bad)
