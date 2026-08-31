import 'reflect-metadata';
import { describe, it, expect, afterAll } from 'vitest';
import { Container } from 'inversify';
import * as fs from 'fs';
import * as path from 'path';

import { HookApp } from './hook-app';
import { HookArgs, HookOutcome } from './hook-outcome';
import { HookStdinSource, HookStdoutSink, HookProcessExit } from './hook-ports';
import { governingShimRoot } from '../bin/shim';
import { managedSurfaceDrift } from '../bin/hook-registration';
import { GOLDEN_FIXTURES, GoldenFixture, GoldenRepoBuilder, PreparedFixture, REPO_TOKEN } from './hook-app-fixtures';

/**
 * THE COMPOSED PIPELINE'S REGRESSION NET — `stdin -> parse -> adapter -> runner -> emit -> exit`, one
 * whole invocation at a time, asserted on the EXACT stdout bytes and the EXACT exit code.
 *
 * ─── Why this file exists ──────────────────────────────────────────────────────────────────────────
 * PR #723 moved the entire hook pipeline onto a normalized AgentHookEvent and claimed Claude Code's
 * behaviour did not change. The evidence was unit-level only: `denyJson()`'s bytes were pinned and the
 * existing suite stayed green. Nothing tested the COMPOSITION — which is exactly what the refactor
 * moved code across. It had no test for a structural reason: `runMain` read `process.stdin` itself and
 * reached `process.stdout.write` / `process.exit` directly, so the only things a test could hold were
 * the pure helpers UNDERNEATH the pipeline. Tests therefore sat too low, and moved with every
 * refactor (that PR rewrote `agent-response.spec.ts`'s call sites wholesale while changing not one
 * assertion).
 *
 * HookApp + the injected ports cut the boundary JUST ABOVE the injection point, and this file drives
 * it: same container, same `container.get(HookApp)`, same `app.run(new HookArgs(...))` as production —
 * only the three lowest-layer process ports are swapped.
 *
 * ─── Where the goldens come from, and why that is the whole point ─────────────────────────────────
 * `__goldens__/hook-app-goldens.json` carries, per fixture, the bytes and exit code CAPTURED BY
 * DRIVING A DIFFERENT BINARY: the PUBLISHED `@webpieces/ai-hook-rules` 0.4.696 in `node_modules`,
 * which is the PRE-#723 code, spawned as a real process over the identical payloads and an identically
 * built fixture repo. Each entry records which binary produced it in `capturedFrom`.
 *
 * That is what makes this a regression net ACROSS the refactor rather than a snapshot of whatever the
 * code happens to do now. A golden that disagrees with the current code is evidence of a behaviour
 * change in the hook — NOT a stale expectation. Do not edit a `capturedFrom: "0.4.696"` value to make
 * a test pass; find what moved.
 *
 * The Codex fixtures whose `capturedFrom` names this repo's own main are marked so deliberately: Codex
 * support (`apply_patch`, read parity, the turn_id discriminator) LANDED in #723, so 0.4.696 has no
 * behaviour to preserve for them — it saw `apply_patch` as an unknown tool and allowed it. Those rows
 * pin the new surface going forward; they are not evidence about the refactor.
 *
 * ─── Why a throwaway repo instead of this one ─────────────────────────────────────────────────────
 * See GoldenRepoBuilder. A verdict computed against the live checkout would change with the branch the
 * suite runs on, and `feature-branch-guard` would make the whole file behave differently on `main`.
 */

// webpieces-disable no-any-unknown -- the goldens file is captured output on disk; the index signature is the widest true statement about a JSON blob whose keys are fixture names
const GOLDENS = JSON.parse(fs.readFileSync(path.join(__dirname, '__goldens__', 'hook-app-goldens.json'), 'utf8')) as Record<string, GoldenRow>;

interface GoldenRow {
    /** The binary that produced these bytes: `0.4.696` (pre-#723) or this repo's main for new surface. */
    readonly capturedFrom: string;
    readonly exitCode: number;
    readonly stdout: string;
}

/** Canned stdin — the payload bytes, handed over without touching `process.stdin`. */
class CannedStdin extends HookStdinSource {
    private readonly raw: string;

    constructor(raw: string) {
        super();
        this.raw = raw;
    }

    override read(): Promise<string> {
        return Promise.resolve(this.raw);
    }
}

/** Captured stdout — every byte the run would have written, concatenated in order. */
class CapturedStdout extends HookStdoutSink {
    written: string = '';

    override write(bytes: string): void {
        this.written += bytes;
    }
}

/**
 * Recorded exit — the code the run would have exited with. It RETURNS rather than exiting, which is
 * the one behavioural difference between this container and production's, and the reason it is safe is
 * that `HookApp.run` does nothing after it.
 */
class RecordedExit extends HookProcessExit {
    code: number | null = null;

    override exit(code: number): void {
        this.code = code;
    }
}

/**
 * A stdin port that REJECTS — the closest stand-in for a broken pipe or a harness that died mid-write.
 * Used only by the fail-closed test at the bottom; every golden fixture gets a working stdin.
 */
class FailingStdin extends HookStdinSource {
    override read(): Promise<string> {
        return Promise.reject(new Error('stdin is gone'));
    }
}

const builder = new GoldenRepoBuilder();
const built: PreparedFixture[] = [];

afterAll(() => {
    for (const prepared of built) fs.rmSync(prepared.root, { recursive: true, force: true });
});

/**
 * ONE invocation through the REAL composition root, with only the three process ports substituted.
 *
 * Note what is NOT substituted: the payload parser, both adapters, the rule engine, the guards, the
 * report renderer and the deny/allow wire shape all run for real. That is the difference between this
 * and the unit specs underneath it.
 */
async function runHook(fixture: GoldenFixture): Promise<HookOutcome> {
    const prepared = builder.build(fixture);
    built.push(prepared);

    const stdout = new CapturedStdout();
    const exit = new RecordedExit();
    const container = new Container({ autobind: true });
    container.bind(HookStdinSource).toConstantValue(new CannedStdin(prepared.stdin));
    container.bind(HookStdoutSink).toConstantValue(stdout);
    container.bind(HookProcessExit).toConstantValue(exit);

    const app = container.get(HookApp);
    await app.run(new HookArgs(fixture.mode));

    // Absolute paths legitimately appear in guard reports (the git-workflow doc pointer, the blocked
    // file). Fold this run's temp repo back to the token the golden was recorded with, so the bytes
    // are portable without weakening the comparison anywhere else.
    return new HookOutcome(stdout.written.split(prepared.repo).join(REPO_TOKEN), exit.code ?? -1);
}

describe('HookApp golden bytes — the composed pipeline, end to end', () => {
    /**
     * THE PRECONDITION, asserted first so its failure is legible.
     *
     * `enforceCommittedShim` runs for real here — nothing about the managed-surface check is stubbed,
     * because the only things this suite substitutes are the three process ports. Under vitest the
     * running module is this SOURCE checkout, so the probe compares the committed
     * `.claude/webpieces/ai-hook.sh` against the LOCAL `renderShim()`.
     *
     * If those two ever disagree, EVERY fixture below turns into an L0 fault-S deny that has nothing to
     * do with what it tests. This assertion is what turns that from an unreadable 8KB byte diff into
     * one sentence naming the drifted surface. Its cure is NOT to touch the goldens: it is the ordinary
     * one-release lag — the committed artifact is regenerated by an upgrade, never inside a webpieces
     * PR that changes the renderer (regenerating it there fires fault S for every consumer).
     */
    it('runs against a tree with no managed-surface drift, so no fixture can become a fault-S deny', () => {
        expect(managedSurfaceDrift(governingShimRoot())).toEqual([]);
    });

    it.each(GOLDEN_FIXTURES.map((fixture: GoldenFixture): [string, GoldenFixture] => [fixture.name, fixture]))(
        '%s emits the captured bytes and exit code',
        async (name: string, fixture: GoldenFixture): Promise<void> => {
            const golden = GOLDENS[name];
            expect(golden, `no golden recorded for ${name}`).toBeDefined();
            const outcome = await runHook(fixture);
            expect(outcome.stdout).toBe(golden.stdout);
            expect(outcome.exitCode).toBe(golden.exitCode);
        },
    );

    /**
     * The tool-conditional `systemMessage` is the one deny detail a human actually SEES, and it is
     * asymmetric: on Bash the `permissionDecisionReason` is invisible to the user, so the deny carries
     * an ANSI-red `systemMessage`; on Write/Edit/MultiEdit the reason already renders red natively and
     * a second line is noise. Asserted here at the COMPOSED level — the byte goldens above would also
     * catch a regression, but only as an 8KB diff that says nothing about which rule broke.
     */
    it('puts the ANSI-red systemMessage on a Bash deny and never on a file-tool deny', () => {
        // `\u001b` is how JSON.stringify serializes the ANSI escape, so the recorded bytes carry the six
        // characters of the escape sequence and no raw ESC byte lives in this file either.
        const red = '\\u001b[31;1m';
        for (const name of ['claude/bash-deny', 'codex/bash-deny']) {
            expect(GOLDENS[name].stdout.startsWith(`{"systemMessage":"${red}`), name).toBe(true);
        }
        for (const name of ['claude/write-deny', 'claude/edit-deny', 'claude/multiedit-deny']) {
            expect(GOLDENS[name].stdout.includes('systemMessage'), name).toBe(false);
            expect(GOLDENS[name].stdout.startsWith('{"hookSpecificOutput"'), name).toBe(true);
        }
    });

    /**
     * An ALLOW writes NOTHING. A bare exit 0 with no stdout IS the allow in the PreToolUse protocol, so
     * any byte on that path would be read as a malformed decision by whichever harness is parsing.
     */
    it('writes no bytes at all on an allow', () => {
        for (const name of ['claude/bash-allow', 'claude/read-allow', 'claude/write-allow', 'codex/bash-allow', 'codex/read-allow']) {
            expect(GOLDENS[name].stdout, name).toBe('');
            expect(GOLDENS[name].exitCode, name).toBe(0);
        }
    });

    /**
     * Every deny — including the two crash paths — exits 0 and carries a NON-EMPTY
     * permissionDecisionReason. Exit 2 would make Claude ignore stdout entirely, and Codex hard-rejects
     * an empty reason, so either mistake is a block that silently fails to block.
     */
    it('emits exit 0 and a non-empty reason on every deny, crashes included', () => {
        for (const name of Object.keys(GOLDENS)) {
            const row = GOLDENS[name];
            expect(row.exitCode, name).toBe(0);
            if (row.stdout === '') continue;
            // webpieces-disable no-any-unknown -- parsing the recorded wire bytes back; the shape asserted is exactly the two fields under test
            const parsed = JSON.parse(row.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
            expect(parsed.hookSpecificOutput.permissionDecision, name).toBe('deny');
            expect(parsed.hookSpecificOutput.permissionDecisionReason.trim(), name).not.toBe('');
        }
    });

    /**
     * THE FAIL-CLOSED BOUNDARY AROUND THE READ ITSELF — the one thing no golden above can reach,
     * because every one of them substitutes a stdin port that works.
     *
     * `runMain` had the stdin read inside the try whose catch produced a deny. Moving the read behind
     * a port could easily have narrowed that without anybody noticing: a rejected read would escape
     * `run`, surface as an unhandled rejection, and exit NON-ZERO — and a non-zero exit is a
     * non-blocking error, so PreToolUse lets the tool call THROUGH. A silent inversion of the one
     * invariant the hook exists for. This pins the restored boundary.
     */
    it('turns a stdin port that rejects into a deny with exit 0, never a non-zero exit', async (): Promise<void> => {
        const stdout = new CapturedStdout();
        const exit = new RecordedExit();
        const container = new Container({ autobind: true });
        container.bind(HookStdinSource).toConstantValue(new FailingStdin());
        container.bind(HookStdoutSink).toConstantValue(stdout);
        container.bind(HookProcessExit).toConstantValue(exit);

        await container.get(HookApp).run(new HookArgs('guards'));

        expect(exit.code).toBe(0);
        // webpieces-disable no-any-unknown -- parsing the bytes just emitted; the shape asserted is exactly the two fields under test
        const parsed = JSON.parse(stdout.written) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('failing closed');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('stdin is gone');
    });

    /**
     * The HookTerminated invariant, pinned by the allows above rather than by a mock.
     *
     * `emitAllow` says "this invocation is over, and the answer is allow" by THROWING, so any catch
     * between it and HookApp that swallowed the throw would turn every allow into a crash-deny. That is
     * exactly what the five allow fixtures would show — empty stdout becoming a `hook crashed`
     * deny — which is why there is no separate mock-driven test for it: the real pipeline, run whole,
     * is a stronger statement than a stubbed one.
     */
    it('keeps allows as allows, which is what proves no catch swallows the terminal throw', () => {
        for (const name of ['claude/bash-allow', 'claude/read-allow', 'claude/write-allow']) {
            expect(GOLDENS[name].stdout, name).toBe('');
        }
    });

    /**
     * A guard rail on the goldens themselves: the Claude rows must still declare that they came from
     * the PRE-#723 published binary. If someone re-records them against current code the file stops
     * being a regression net and becomes a snapshot, and nothing else in the suite would notice.
     */
    it('keeps every Claude Code golden attributed to the pre-refactor published binary', () => {
        for (const name of Object.keys(GOLDENS)) {
            if (!name.startsWith('claude/')) continue;
            expect(GOLDENS[name].capturedFrom, name).toBe('0.4.696');
        }
    });
});
