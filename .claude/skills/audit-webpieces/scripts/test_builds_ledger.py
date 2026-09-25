"""Guards `kill_signal()` — what builds_ledger.py counts as a KILLED build.

Why this test exists: the script once mapped `exit=130` to SIGINT and reported every such DONE-FAIL
as a killed-and-re-run "wasted" build. nx 22 exits `signalToCode('SIGINT')` = 130 whenever a run is
not completed — which every failed task causes, by leaving its dependents unrun — so one audit turned
165 ordinary red gate builds into "killed builds" (issue #1043). The ledger itself writes `signal=` only
when Node saw a real signal; that field, or exit 137/143, is the only trustworthy kill evidence.

Rows below are real ledger shapes, parsed through the same `kv()` + `build_records()` path the audit uses.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ledger', os.path.join(HERE, 'builds_ledger.py'))
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)

START_MS = 1_790_000_000_000


def build_for(done_fields):
    """One START + one DONE row through the real parser; returns the single build record."""
    start = '\t'.join(['START', 'id=b1', 't=x', 'ms=%d' % START_MS, 'by=review',
                       'repo=/r', 'tree=/r', 'cwd=/r', 'branch=f', 'pid=1', 'wp=0.4.815'])
    kind, extra = done_fields[0], done_fields[1:]
    done = '\t'.join([kind, 'id=b1', 't=y', 'ms=%d' % (START_MS + 60_000), 'by=review',
                      'repo=/r', 'took=60000'] + extra + ['pid=1'])
    rows = []
    for line in (start, done):
        r = ledger.kv(line)
        r['_ms'] = int(r['ms'])
        rows.append(r)
    builds = ledger.build_records(rows, 0)
    assert len(builds) == 1, builds
    return builds[0]


# (name, DONE row [KIND, *k=v fields], expected kill signal or None)
CASES = [
    ('exit=130 no signal is RED, not killed (nx incomplete run)',
     ['DONE-FAIL', 'exit=130'], None),
    ('signal=SIGINT is killed', ['DONE-FAIL', 'exit=null', 'signal=SIGINT'], 'SIGINT'),
    ('exit=130 WITH signal=SIGINT is killed', ['DONE-FAIL', 'exit=130', 'signal=SIGINT'], 'SIGINT'),
    ('exit=137 is killed', ['DONE-FAIL', 'exit=137'], 'SIGKILL'),
    ('exit=143 is killed', ['DONE-FAIL', 'exit=143'], 'SIGTERM'),
    ('exit=1 is red, not killed', ['DONE-FAIL', 'exit=1'], None),
    ('success is not killed', ['DONE-SUCCESS'], None),
]


def main():
    failures = 0
    for name, fields, want in CASES:
        b = build_for(fields)
        got = ledger.kill_signal(b)
        in_wasted = bool(ledger.wasted([b]))
        killed_count = ledger.by_version([b])['versions']['0.4.815']['killed']
        ok = got == want and in_wasted == (want is not None) and killed_count == (1 if want else 0)
        if not ok:
            failures += 1
            print('FAIL want=%-7s got=%-7s wasted=%-5s killed=%d | %s'
                  % (want, got, in_wasted, killed_count, name))
        else:
            print('ok   want=%-7s | %s' % (want, name))
    print('FAILURES: %d' % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
