import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { InvocationLog, logGuardDecision, GuardDecision , MATRIX_L2_UNROWED } from './decision-log';
import { LogStream } from './log-stream';
import { L0_FAULTS, L0Fault } from './l0-matrix';
import { L0_JS_FAULT_CODES, L0_SH_FAULT_CODES, L0_FAULT_NONE } from './l0-fault-codes';
import { logRejection } from './rejection-log';
import { run } from './runner';
import { NormalizedToolInput, NormalizedEdit, BlockedResult } from './types';
import { SHIM_LOG_FAULTS, renderShim } from '../bin/shim';
import { L2_DECISIONS_STREAM, CALLS_STREAM, REJECTIONS_STREAM } from './log-streams';

function tmpRoot(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-faultstamp-')));
}

// The three STREAM DIRECTORIES this fault stamp must reach. `fault=` spans them all — that is the
// property under test — so they are named by stream, not by a historical flat filename.
const INVOCATION_LOG = CALLS_STREAM;
const DECISION_LOG = L2_DECISIONS_STREAM;
const REJECTION_LOG = REJECTIONS_STREAM;

// The filename LogStream actually writes — it prefixes every log with
// <session>-<agent|coordinator>-<hook>-, which is how concurrent writers stay out of one file.
function readLog(root: string, name: string): string {
    // `name` selects the STREAM DIRECTORY now; the file inside it is this writer's key.
    const dir = path.join(root, '.webpieces', 'logs', name);
    return fs.readFileSync(path.join(dir, new LogStream().writerFile('.log')), 'utf8');
}

/**
 * THE VOCABULARY PARTITION — the assertion a NEW fault has to fail.
 *
 * `fault=` is only worth having if `grep 'fault=S'` spans the WHOLE trail and the faults observed can
 * be diffed against `L0_FAULTS`. Both properties die the moment a fault is declared in the matrix and
 * no emitter knows about it — which is exactly the state S/C/Y were in: enforced in the bin, and
 * reaching the audit trail with no label at all. So the test is driven from `L0_FAULTS`, never from a
 * hand-written list: add an eighth fault without assigning it to an enforcement half and this goes red.
 */
describe('every declared L0 fault belongs to exactly one emitting half', () => {
    it('partitions L0_FAULTS into the sh-side and JS-side code lists, with no leftovers', () => {
        const declared = L0_FAULTS.map((fault: L0Fault): string => fault.code).sort();
        const emitted = [...L0_SH_FAULT_CODES, ...L0_JS_FAULT_CODES].sort();
        expect(emitted).toEqual(declared);
    });

    it('agrees with each fault\'s own `enforcedIn` column, so the lists cannot drift from the table', () => {
        const shDeclared = L0_FAULTS.filter((f: L0Fault): boolean => f.enforcedIn === 'sh').map((f: L0Fault): string => f.code);
        const jsDeclared = L0_FAULTS.filter((f: L0Fault): boolean => f.enforcedIn === 'JS').map((f: L0Fault): string => f.code);
        expect([...L0_SH_FAULT_CODES]).toEqual(shDeclared);
        expect([...L0_JS_FAULT_CODES]).toEqual(jsDeclared);
    });
});

/**
 * EVERY fault can appear in the trail with its stamp. The sh half is checked against the rendered shim
 * (that is where its letters are assigned); the JS half is driven end-to-end through the real writers,
 * because "the constant exists" would have been true of S/C/Y the whole time they were unlabelled.
 */
describe('every L0 fault code can appear in the audit trail with its `fault=` stamp', () => {
    it('assigns each sh-side code in the rendered shim and lists it in the shim log vocabulary', () => {
        const shim = renderShim();
        for (const code of L0_SH_FAULT_CODES) {
            expect(shim, `fault ${code} is never assigned in the shim`).toContain(`WP_FAULT=${code}`);
            expect([...SHIM_LOG_FAULTS], `fault ${code} missing from the shim log vocabulary`).toContain(code);
        }
    });

    it('stamps each JS-side code onto the invocation line, the decision line AND the rejection index', () => {
        for (const code of L0_JS_FAULT_CODES) {
            const root = tmpRoot();

            const invocations = new InvocationLog();
            invocations.begin(root, 'Bash', 'pnpm build');
            invocations.finish('BLOCK_AI_CURE', 'some-rule', code);
            expect(readLog(root, INVOCATION_LOG), `invocation line, fault ${code}`).toContain(`\tfault=${code}\n`);

            logGuardDecision(root, new GuardDecision('some-rule', 'Bash', 'pnpm build', 'dean/x', 'BLOCK_AI_CURE', 'why', '-', code, MATRIX_L2_UNROWED));
            expect(readLog(root, DECISION_LOG), `decision line, fault ${code}`).toContain(`\tfault=${code}\n`);

            const input = new NormalizedToolInput(path.join(root, 'src/x.ts'), [new NormalizedEdit('a', 'b')]);
            logRejection('Edit', input, new BlockedResult('[some-rule] (a reason)\nblocked', code), root);
            expect(readLog(root, REJECTION_LOG), `rejection line, fault ${code}`).toContain(`\tfault=${code}\n`);
        }
    });

    // The `-` case is what makes the field countable: `cut -f… | sort | uniq -c` needs a value on
    // EVERY line, not a field that appears only when something went wrong.
    it('stamps `-` on an ordinary call, so every line carries the field', () => {
        const root = tmpRoot();
        const invocations = new InvocationLog();
        invocations.begin(root, 'Bash', 'ls');
        invocations.finish('ALLOW', '-');
        expect(readLog(root, INVOCATION_LOG)).toContain(`\tfault=${L0_FAULT_NONE}\n`);
    });

    // Fault C for real, from the code path that decides it: no webpieces.config.json anywhere above a
    // temp dir. This is the half a constant cannot prove — that the PRODUCER stamps what it decided.
    it('is stamped by the producer: a config-missing block really carries fault C', () => {
        const root = tmpRoot();
        const input = new NormalizedToolInput(path.join(root, 'src/x.ts'), [new NormalizedEdit('', 'x')]);
        const result = run('Write', input, root, 'all');
        expect(result).not.toBeNull();
        expect(result?.fault).toBe('C');
    });

    it('leaves an ordinary rule block unstamped', () => {
        expect(new BlockedResult('anything').fault).toBe(L0_FAULT_NONE);
    });
});

/**
 * Logging is best-effort EVERYWHERE in this codebase and must stay that way: an audit line is never
 * worth failing a tool call for. Every writer touched here is exercised against a destination that
 * cannot be created (a FILE where the log directory must go).
 */
describe('a log failure never throws', () => {
    it('swallows an unwritable destination in all three writers', () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, '.webpieces'), { recursive: true });
        fs.writeFileSync(path.join(root, '.webpieces', 'logs'), 'not a directory');

        const invocations = new InvocationLog();
        expect(() => {
            invocations.begin(root, 'Bash', 'ls');
            invocations.finish('BLOCK_AI_CURE', 'r', 'C');
        }).not.toThrow();

        expect(() => logGuardDecision(root, new GuardDecision('r', 'Bash', 'ls', 'b', 'BLOCK_AI_CURE', 'why', '-', 'C', MATRIX_L2_UNROWED))).not.toThrow();

        const input = new NormalizedToolInput(path.join(root, 'src/x.ts'), [new NormalizedEdit('a', 'b')]);
        expect(() => logRejection('Edit', input, new BlockedResult('[r] (x)\nno', 'C'), root)).not.toThrow();
    });
});
