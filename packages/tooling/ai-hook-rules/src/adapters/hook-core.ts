import * as path from 'path';

import { run, runBash, runRead } from '../core/runner';
import { branchStateHangTimeoutFor } from '../core/main-sync-timeout';
import { logRejection, extractRuleNames } from '../core/rejection-log';
import { logGuardDecision, GuardDecision, branchForLog, invocationLog, MATRIX_L0_BLOCK, matrixL2Row } from '../core/decision-log';
import { triggerMainSyncRefresh } from '../core/main-sync-refresh';
import { CONFIG_FILENAME } from '../core/load-config';
import { RepoRootFinder, renderRuleFailForAi } from '@webpieces/rules-config';
import { NormalizedToolInput, InformAiError, RuleFailError, HookMode, BlockedResult } from '../core/types';
import { AgentHookEvent, AiType, FileOperation } from '../core/agent-event';
import { toError } from '../core/to-error';
import { emitDeny, emitAllow, denyOutcome } from './agent-response';
import { HookOutcome, HookTerminated } from './hook-outcome';
import { AgentPayload, AgentPayloadParser } from './agent-payload';
import { AgentAdapters } from './agent-adapters';
import { detectAiType } from './detect-ai';
import { CodexSubagentSharedTreeGuard, CODEX_SUBAGENT_RULE } from './codex-subagent-guard';
import { governingShimRoot, isAllowed, installedShimRulesVersion } from '../bin/shim';
import { managedSurfaceDrift } from '../bin/hook-registration';
import { shimStaleDenyReason } from '../bin/shim-deny-reason';
import { writeGuardMatrixDoc, guardMatrixPointer } from '../core/l0-matrix';
import { logStream, StreamIdentity } from '../core/log-stream';
import { aiTypeContext } from '../core/ai-type-context';
import { L0_FAULT_SHIM_STALE, L0_FAULT_NONE } from '../core/l0-fault-codes';

// Which category of rules this hook invocation runs. The hook is split into two independently
// installable PreToolUse hooks; each runs ONE category (the runner filters by it), and both can
// receive file AND bash payloads:
//  - 'rules'  → code-style rules (file/edit scope). Bash payloads pass through (no code rules apply).
//  - 'guards' → hookGuards section: bash git/PR guards on Bash AND file guards (feature-branch-guard)
//               on Write/Edit, PLUS a log-and-allow audit of Read. Matcher is Write|Edit|MultiEdit|Bash|Read.
//  - 'all'    → both categories, used by the openclaw plugin adapter (a single before_tool_call hook).
export type { HookMode };

const ADAPTERS = new AgentAdapters();
const SUBAGENT_GUARD = new CodexSubagentSharedTreeGuard();

// The rule name for a block's audit line: the FIRST rule the report cites, or `fallback` when the
// report opens with no `[rule]` header (a hand-written guard message). Comma-joined when a report
// cites several, so `rule=` never silently drops one.
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function blockingRule(report: string, fallback: string): string {
    const names = extractRuleNames(report);
    return names.length > 0 ? names.join(',') : fallback;
}

// webpieces-disable no-function-outside-class -- sibling of handleRead()/handleFileTool() in this module; the adapter is module-scope functions by design
function handleBash(event: AgentHookEvent, cwd: string, mode: HookMode): never {
    const command = event.bash === null ? '' : event.bash.command;
    if (command.trim() === '') { emitAllow(); }

    // READ PARITY, and it can only ever be reached from a Codex event: the adapter leaves `reads`
    // empty for Claude Code, which has a real `Read` tool and its own fast path. A Codex read arrives
    // as `Bash` running a pager, so without this the read guard and the `calls/` audit trail see none
    // of them. The command is STILL run through the bash guards below — this adds a verdict, it never
    // replaces one.
    for (const readPath of event.reads) {
        handleRead(event, readPath, cwd, mode);
    }

    // The HARNESS travels with the command. Fault C and fault Y are decided inside the runner, and
    // both consult the L0 allowlist — which since the gated entry exists cannot be asked without
    // knowing who is calling. `event.aiType` is the adapter's answer, the same one that routed this
    // call to the Codex read-parity loop above.
    const result = runBash(command, cwd, mode, event.aiType);
    if (!result) { emitAllow(); }
    // NO DECISION LINE HERE. This used to write a generic `bash-guard` line because a Bash deny once
    // had no audit trail at all — but every layer now records its own: L1 into `L1-location/` with its
    // row, L2's guards into `L2-decisions/` with their rule and cache, and emitDeny below stamps the
    // call-level outcome onto `calls/`. So this was the THIRD line for one block, and the worst of the
    // three: it re-resolved the root from `cwd` via RepoRootFinder, which is not necessarily the tree
    // the guard actually judged, so a `cd`-relocated command scattered one block across two different
    // `.webpieces` directories.
    //
    // Bash deny → the event's kind is 'Bash', so denyJson adds the ANSI-red systemMessage (the only
    // field a Bash deny shows the human; permissionDecisionReason is invisible on Bash). See
    // agent-response.ts.
    emitDeny(event, result.report, blockingRule(result.report, 'bash-guard'), result.fault);
}

/**
 * The read-scoped guard pass. Returns normally to ALLOW; only calls emitDeny when the guard fires.
 *
 * Wrapped in its own catch that swallows into an allow. Every other path in this hook fails CLOSED,
 * and that is right for edits and shell commands — but a crash here would block the agent from
 * READING, which includes reading webpieces.config.json to turn the offending guard off. So this one
 * path deliberately inverts the policy: a broken read-guard degrades to a no-op, never to a wedge.
 */
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function handleRead(event: AgentHookEvent, filePath: string, cwd: string, mode: HookMode): void {
    if (filePath === '') return;
    let result: BlockedResult | null = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        result = runRead(filePath, cwd, mode);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return; // fail OPEN — see the doc comment
    }
    if (!result) return;
    logRejection('Read', new NormalizedToolInput(filePath, []), result, cwd);
    emitDeny(event, result.report, blockingRule(result.report, 'read-guard'), result.fault);
}

/**
 * Read-only tools (Read): audit-log, warm the main-sync cache, then run the ONE read-scoped guard
 * (read-stale-guard) and allow. Runs BEFORE the general rule engine — no code-style rule ever sees a
 * Read, and the only way this path can deny is a stale `main`. The audit trail still records every
 * file the AI opened (see setup.ts).
 *
 * Returns normally ONLY when the event is not a Read; otherwise it ends the invocation.
 */
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function handleReadFastPath(event: AgentHookEvent, cwd: string, mode: HookMode): void {
    if (event.kind !== 'Read') return;
    const readPath = event.reads.length > 0 ? event.reads[0] : '';
    if (mode !== 'rules') {
        invocationLog.begin(cwd, event.rawToolName, readPath);
        // Reads vastly outnumber edits, so refreshing here is what actually keeps the shared
        // main-sync cache warm for feature-branch-guard. Detached; never slows the read.
        triggerMainSyncRefresh(cwd, branchStateHangTimeoutFor(cwd));
    }
    handleRead(event, readPath, cwd, mode);
    emitAllow();
}

/**
 * The file/edit pipeline, run once per file the call touches.
 *
 * `event.files` is a LIST because ONE Codex `apply_patch` carries many files with mixed operations.
 * A Claude Code event always has exactly one entry, so the loop runs once and the behaviour is the
 * single-file behaviour it has always had.
 */
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleRead() in this module; the adapter is module-scope functions by design
function handleFileTool(event: AgentHookEvent, cwd: string, mode: HookMode): never {
    if (event.files.length === 0) { emitAllow(); }

    // A Codex SUBAGENT writing into the tree it shares with its coordinator. Returns null for every
    // Claude Code event — that harness can hand a subagent its own worktree, and does.
    const subagentBlock = SUBAGENT_GUARD.check(event, new RepoRootFinder().resolveRepoRoot(cwd));
    if (subagentBlock) {
        emitDeny(event, subagentBlock.report, CODEX_SUBAGENT_RULE, subagentBlock.fault);
    }

    for (const file of event.files) {
        handleOneFile(event, file, cwd, mode);
    }
    emitAllow();
}

// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function handleOneFile(event: AgentHookEvent, file: FileOperation, cwd: string, mode: HookMode): void {
    const input = file.input;

    // Always allow edits to webpieces.config.json — it's the fix target when the config is broken.
    // This returns BEFORE run(), so feature-branch-guard never sees a config edit; record that so the
    // audit trail explains why a config edit on a bad branch was not blocked (see decision-log.ts).
    if (path.basename(input.filePath) === CONFIG_FILENAME) {
        if (mode !== 'rules') {
            // `.webpieces/` (the decision log + sync cache these two calls write) lives at the repo
            // root, not the AI's cwd — resolve it so a config edit from a subdir doesn't create a
            // stray `<subdir>/.webpieces` tree.
            const root = new RepoRootFinder().resolveRepoRoot(cwd);
            logGuardDecision(
                root,
                new GuardDecision('feature-branch-guard', file.toolKind, input.filePath, branchForLog(root), 'ALLOW_EXEMPT', 'config-bypass (feature-branch-guard skipped)', '-', L0_FAULT_NONE, matrixL2Row('config-bypass (feature-branch-guard skipped)')),
            );
            // The guard's own refresh trigger lives inside its check(), which we skip here — so warm
            // the cache directly, otherwise a session that only edits webpieces.config.json never
            // refreshes the sync status. Fire-and-forget; never blocks the edit.
            triggerMainSyncRefresh(root, branchStateHangTimeoutFor(cwd));
        }
        return;
    }

    const result = run(file.toolKind, input, cwd, mode);
    if (!result) return;

    logRejection(file.toolKind, input, result, cwd);
    // File-tool deny → the event's kind is 'File', so denyJson omits systemMessage (the reason
    // already renders red natively for these tools). See agent-response.ts.
    emitDeny(event, result.report, blockingRule(result.report, 'file-guard'), result.fault);
}

// What a stale committed shim lets through — now a thin adapter over the ONE L0 allowlist (isAllowed in
// ../bin/shim), not a list of its own. A stale shim must NEVER trap the actions needed to recover: the
// original "block everything but the cures" version also shadowed the always-allowed
// webpieces.config.json edit (handleFileTool) and blocked reads, so a repo that ALSO needed its config
// fixed would deadlock — blocked from editing the one file whose edit is normally always allowed, and
// blocked from reading it to know how.
//
// It used to carry its OWN narrower list (isShimCureCommand: the three shim cures only), and that
// narrowness was a defect, not a safety property: `pnpm install` and `git pull` — the two commands that
// resolve the version disagreement underneath a stale shim — were denied. Consulting the shared
// allowlist fixes that by construction.
//
// What is NOT a defect, and must not be "fixed": those cures rewrite the committed shim from the
// INSTALLED binary's renderShim(), overwriting whatever was there. That is the invariant, not
// collateral damage. The shim (D/X/K, in POSIX sh, pre-binary) and this binary (S/C/Y, in JS) are two
// halves of ONE L0 and they exchange assumptions — the shim parses file_path and carries ALLOW-READ /
// ALLOW-CONFIG entries this binary relies on. Pair a binary with a shim rendered by a DIFFERENT
// release and L0 acquires holes that nothing reports. So the rule is absolute: the committed shim
// equals renderShim() of the binary in node_modules, and a cure that forces that is the cure working.
// See healShim's header, which states the same invariant from the other side.
//
// Corollary for anyone regenerating the shim in a webpieces PR: commit `templates/ai-hook.sh` (source,
// locked to renderShim() by unit test) and leave `.claude/webpieces/ai-hook.sh` (generated artifact)
// alone. In THIS repo the local source runs ahead of the pinned node_modules, so committing a shim
// rendered from local source produces a commit whose shim and whose @webpieces pin come from different
// releases — precisely the mismatch above. The artifact heals on the next upgrade; that is its job.
//
//   - 'allow-cure' → a Bash cure on the allowlist: emitAllow directly, bypassing the git guards.
//   - 'pass'       → a recovery action the normal flow already permits, so fall THROUGH and let it: ANY
//                    Read (you must read to know how to fix — see handleRead, which itself fails open),
//                    or an edit to webpieces.config.json (the always-allowed recovery target).
//   - 'deny'       → all OTHER work: blocked until the committed shim matches renderShim() again.
export type ShimStaleDecision = 'allow-cure' | 'pass' | 'deny';
// webpieces-disable no-function-outside-class -- pure decision helper beside the adapter's other module-scope functions; exported for direct unit testing.
export function shimStaleRecoveryDecision(toolName: string, command: string, filePath: string, aiType: AiType): ShimStaleDecision {
    const allowed = isAllowed(toolName, command, filePath, aiType);
    if (allowed === 'pass') return 'pass';
    if (allowed === 'allow') return 'allow-cure';
    return 'deny';
}

// MANAGED-HOOK-SURFACE self-guard, moved here from the rendered shim (2026-07-24) and widened from one
// file to three (2026-08-07). The committed
// .claude/webpieces/ai-hook.sh is webpieces-MANAGED and generated from renderShim(); if it no longer
// matches, it was reverted / hand-edited / predates this binary, so its OWN fail-closed logic can't be
// trusted. We are the CURRENT binary from node_modules — the trustworthy party — so WE decide here
// instead of the (possibly stale) shim. It used to `cmp` itself inside the shim: a double-edged trap,
// since the check lived in the very file it guarded and a fix could only ship by regenerating that
// file. Now we fail closed on all real WORK while always leaving the recovery path open (see
// shimStaleRecoveryDecision): the whole L0 allowlist, any Read, and editing webpieces.config.json. We deny +
// tell the AI; we do NOT silently rewrite the file under it. 'rules' hook skips it (guards owns the
// shim). Returns normally (pass / nothing to do) or exits via emitAllow/emitDeny.
//
// It asks the allowlist about the RAW WIRE FIELDS, not about the normalized event, and that ordering is
// deliberate: L0 has to hold on a tree too broken to trust anything above it, including the adapters.
// The raw fields are the same key names in both harnesses (measured), so one reading serves both, and
// the answer cannot change because a normalizer changed. `event` is here only to decorate the deny.
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function enforceCommittedShim(payload: AgentPayload, event: AgentHookEvent, cwd: string, mode: HookMode): void {
    // ONE root for the whole decision, resolved from the RUNNING MODULE (governingShimRoot), never from
    // `cwd`: the shim file we compare and the renderShim() we compare it TO must come from the same
    // install, or the check straddles two trees and can never converge (see governingShimRoot's header).
    // `cwd` still selects where the L0 matrix doc is dropped — that is a "where does the AI read" question,
    // not part of the judgement.
    const shimRoot = governingShimRoot();
    if (mode === 'rules') return;
    // WHICH of the managed things moved — ai-hook.sh, either harness's hook registration
    // (.claude/settings.json, .codex/hooks.json), or the Claude settings' managed env entry (the
    // Bash-cwd pin that keeps a guard's verdict independent of where an earlier `cd` left the shell;
    // see managed-env.ts). Nothing validated the registration before it joined this
    // fault, so a settings file left on a superseded form silently changed WHO GOVERNS, with no signal
    // anywhere — which is the whole reason the registration is a drift surface and not just an install
    // step.
    const drifted = managedSurfaceDrift(shimRoot);
    if (drifted.length === 0) return;
    // The harness comes from the RAW envelope too — `detectAiType` asks one question of one key, so it
    // is as trustworthy here as the wire fields beside it, and it is the PRECISE test the shim's sh half
    // can only approximate. Reading it off the normalized event instead would put a normalizer between
    // L0 and its decision, which is the coupling the paragraph above exists to refuse.
    const decision = shimStaleRecoveryDecision(
        payload.tool_name, payload.tool_input.command ?? '', payload.tool_input.file_path ?? '',
        detectAiType(payload));
    if (decision === 'pass') return;
    if (decision === 'allow-cure') emitAllow();
    // Drop the L0 matrix doc where the AI can read it and point the deny at it — a Read is entry 1 of
    // the same allowlist, so the pointer is always followable. Best-effort: no doc → no pointer.
    const root = new RepoRootFinder().resolveRepoRoot(cwd);
    const docPath = writeGuardMatrixDoc(root);
    // WRITE THE AUDIT LINE HERE. This block happens BEFORE invocationLog.begin() — it has to, since a
    // stale shim invalidates everything downstream — so emitDeny's flush finds nothing pending and an
    // `S` storm left NO trace at all: the one fault most likely to block twenty consecutive tool calls
    // was the one fault the trail could not show. A decision line is the fix that costs no reordering.
    const target = payload.tool_input.command ?? payload.tool_input.file_path ?? '';
    logGuardDecision(
        root,
        new GuardDecision('committed-shim-stale', payload.tool_name, target, branchForLog(root), 'BLOCK_AI_CURE', 'L0 fault S (committed shim != renderShim)', '-', L0_FAULT_SHIM_STALE, MATRIX_L0_BLOCK),
    );
    // L0 fault S in GUARD_MATRIX.md's codebook — named as the blocking rule so the invocation line
    // says WHAT stopped the call, not merely that something did, and stamped as `fault=S` so the same
    // grep finds it here as in the sh half's `L0-shim/` stream.
    // A subagent is discriminated by `agent_id`, which BOTH harnesses populate on stdin only off the
    // main loop (main falls back to the session id / leaves it empty). Its cure differs: the hooks
    // blocking it resolve through CLAUDE_PROJECT_DIR, which names the MAIN tree.
    const inSubagent = event.agentId !== '';
    emitDeny(event, shimStaleDenyReason(installedShimRulesVersion(), shimRoot ?? '', drifted, inSubagent) + guardMatrixPointer(docPath), 'committed-shim-stale', L0_FAULT_SHIM_STALE);
}

/**
 * THE PIPELINE, from raw stdin bytes to the decision — the whole of `parse -> adapter -> runner ->
 * emit`, as ONE function returning ONE value.
 *
 * `mode` selects which tool kinds to validate; payloads outside the mode's scope pass through
 * (emitAllow). A block is a PreToolUse `permissionDecision:"deny"` JSON on stdout with exit 0 — see
 * agent-response.ts. Fails CLOSED on any unexpected crash (returns a deny) so a broken hook never
 * silently lets an edit through, and the reason surfaces in the agent's UI instead of being hidden on
 * a stderr+exit-2 block.
 *
 * It reads NO stdin, writes NO stdout and calls NO exit: those three couplings are ports owned by
 * HookApp (see hook-ports.ts), which is what makes the composed pipeline drivable from a test. This
 * function is what `runMain` was; it is not a second spelling of it — `runMain` is deleted, and
 * `HookApp.run()` is the only entry point.
 */
// webpieces-disable no-function-outside-class -- the module-scope hook body itself, sibling of handleBash()/handleFileTool(); the adapter is module-scope functions by design and must stay callable from a tree too broken to build a DI container
export function runPipeline(raw: string, mode: HookMode): HookOutcome {
    // Captured as soon as the ENVELOPE parses so the fail-closed catch below can tell denyJson which
    // kind of call it is denying — a crash on a Bash call still gets the visible red systemMessage, a
    // crash on a file tool does not. Null (before parse / malformed input) → treated as non-Bash.
    let event: AgentHookEvent | null = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const payload = new AgentPayloadParser().parse(raw);
        if (!payload) { emitAllow(); }
        // The envelope shape first: it reads only `tool_name` and the identity fields, so it cannot
        // fail, and it is what the crash path needs. The full normalization below reads `tool_input`
        // and CAN fail (a malformed Codex patch envelope denies rather than being half-understood).
        event = ADAPTERS.envelope(payload);

        // BEFORE enforceCommittedShim(), which can itself write a BLOCK line. See LogStream for why
        // all three of session/agent/hook are needed to keep concurrent writers off one file.
        logStream.identify(new StreamIdentity(event.sessionId, event.agentId, mode));
        // Same moment, same reason: every JS-side stream stamps `ai=`, and the fault-S line written
        // inside enforceCommittedShim() is one of them. See AiTypeContext for why the harness is a
        // process-wide holder rather than a parameter on four writers.
        aiTypeContext.identify(event.aiType);

        // Prefer the payload cwd (the AI's actual working dir, follows a persisted `cd`) over
        // process.cwd(); they match today, but the payload is the authoritative signal and stays
        // correct if the hook is ever invoked from a fixed dir (e.g. via $CLAUDE_PROJECT_DIR).
        const cwd = payload.cwd ?? process.cwd();

        // Committed-shim self-guard: blocks real work while the committed shim is stale, but keeps the
        // recovery path open (cures, reads, config edit). See enforceCommittedShim / shimStaleRecoveryDecision.
        enforceCommittedShim(payload, event, cwd, mode);

        event = ADAPTERS.toEvent(payload, cwd);

        // Read-only tools: their own fast path, which never returns when it applies.
        handleReadFastPath(event, cwd, mode);

        // Per-invocation guard log (the `calls/` stream): tool + command/file + live branch +
        // main-sync-status snapshot, on EVERY guards call, for later cleanup automation. Best-effort;
        // never blocks the call. (The committed shim is no longer silently healed here — a mismatch is
        // reported by the self-guard above, not rewritten out from under the AI.)
        if (mode !== 'rules') {
            invocationLog.begin(cwd, event.rawToolName, logTarget(event));
        }

        if (event.kind === 'Bash') {
            // No code-style rule is bash-scoped, so the rules hook ignores Bash.
            if (mode === 'rules') { emitAllow(); }
            handleBash(event, cwd, mode);
        }

        // File payloads run in 'rules' (code-style), 'guards' (file-scoped guards like
        // feature-branch-guard), and 'all'. The runner filters to the right category.
        handleFileTool(event, cwd, mode);
    } catch (err: unknown) {
        const error = toError(err);
        // The pipeline's own terminal control flow, not a failure: emitAllow/emitDeny threw the answer
        // out to here from wherever they were called. Treating it as a crash would turn every allow
        // into a deny, so this branch comes FIRST and returns the carried outcome verbatim.
        if (error instanceof HookTerminated) return error.outcome;
        return denyForCrash(error, event);
    }
}

// What the `calls/` audit line names as the call's target: the command for a shell call, else the first
// file it touches. A Codex `apply_patch` touching several files names the first — the rejection log and
// the decision log carry the rest, per file.
// webpieces-disable no-function-outside-class -- sibling of the module-scope hook entry points in this adapter
function logTarget(event: AgentHookEvent): string {
    if (event.kind === 'Bash') return event.bash === null ? '' : event.bash.command;
    return event.files.length > 0 ? event.files[0].input.filePath : '';
}

/**
 * The fail-closed boundary for anything that escaped the hook body. An escaped RuleFailError (a rule
 * that threw past the runner's per-rule catch) or an InformAiError (bad config/stdin, or a Codex patch
 * envelope this parser refuses to guess at) both carry an AI-readable message; anything else is an
 * unexpected bug. All three DENY and surface their reason, because a hook that crashed established
 * nothing and must never be read as an allow.
 *
 * It BUILDS the deny (denyOutcome) rather than throwing it (emitDeny), because it is already inside
 * the catch that the throw would land in — see HookTerminated. Same bytes either way.
 */
// webpieces-disable no-function-outside-class -- sibling of the module-scope hook entry points in this adapter; a lone class for one terminal boundary would break the file's shape
function denyForCrash(error: Error, event: AgentHookEvent | null): HookOutcome {
    if (error instanceof RuleFailError) {
        return denyOutcome(event, renderRuleFailForAi(error), 'rule-crash');
    }
    if (error instanceof InformAiError) {
        return denyOutcome(event, error.message, 'bad-config-or-stdin');
    }
    return denyOutcome(event, `[ai-hooks] hook crashed unexpectedly — failing closed: ${error.message}`, 'hook-crash');
}
