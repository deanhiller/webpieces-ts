import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { DotWebpieces, dotWebpieces } from './state-dir';
import { matchesAnyGlob } from './exclude-paths';
import { toError } from './to-error';

// The directory under `.webpieces/` that holds one authorization file per branch. Gitignored with the
// rest of `.webpieces/` — deliberately, see HumanAuthorizationService's docstring.
export const AUTHORIZATIONS_DIR = 'authorizations';

// How long a fresh approval is good for, in hours, when the human does not say otherwise. An approval is
// for TODAY'S work, not a standing grant: the thing being authorized is a specific partial delivery, and
// a grant that outlives the sitting it was given in is one nobody remembers giving.
export const DEFAULT_APPROVAL_HOURS = 4;

// The marker version in the signed payload. An approval signed under a different version does not verify,
// so the payload can gain a field without a stale entry silently continuing to pass.
const PAYLOAD_VERSION = 'wp-authorize-v1';

/**
 * ONE human approval of ONE checklist's override, on ONE branch. Data-only (per CLAUDE.md).
 *
 * `approves` is prose the human typed at the tty in their own words, and it is the POINT of the record:
 * `wp-check-auth` prints it, so a reviewer can judge whether the approval actually covers the thing it is
 * being applied to — not merely that *an* approval exists on this branch.
 *
 * `hmac` is `HMAC-SHA256(prGate.gateSalt, canonical payload)` over every other field plus the branch. It
 * is what makes the approval VERIFIABLE by an agent that cannot MINT one: the agent runs `wp-check-auth`,
 * which recomputes the HMAC, rather than believing a claim relayed to it in a message.
 */
export class HumanApproval {
    checklist: string;    // the checklist id this authorizes an override of (= the reviewer subagent name)
    gate: string;         // the specific gate inside that checklist, or '' for the checklist as a whole
    approves: string;     // the human's OWN words: what they are approving and why
    scopePaths: string[]; // globs the diff touched when approved; the approval dies if it grows past them
    forkPoint: string;    // merge-base when approved; survives new commits, dies on a re-based branch
    issuedAt: string;     // ISO
    expiresAt: string;    // ISO
    hmac: string;         // '' until signed

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        checklist: string,
        gate: string,
        approves: string,
        scopePaths: string[],
        forkPoint: string,
        issuedAt: string,
        expiresAt: string,
        hmac = '',
    ) {
        this.checklist = checklist;
        this.gate = gate;
        this.approves = approves;
        this.scopePaths = scopePaths;
        this.forkPoint = forkPoint;
        this.issuedAt = issuedAt;
        this.expiresAt = expiresAt;
        this.hmac = hmac;
    }
}

/**
 * The append-only authorization file for ONE branch: N approvals, each naming what it approves. Data-only.
 *
 * The unit is the BRANCH, not the gate, because one run of work routinely needs more than one override and
 * they arrive at different times. One file per gate would mean the human re-answering the same "where does
 * this go?" question on every approval.
 */
export class AuthorizationFile {
    branch: string;
    approvals: HumanApproval[];

    constructor(branch = '', approvals: HumanApproval[] = []) {
        this.branch = branch;
        this.approvals = approvals;
    }
}

/**
 * The git facts an approval is verified AGAINST, gathered once by the caller. Data-only.
 *
 * A data class rather than four parameters because the four must describe ONE branch state: a `forkPoint`
 * resolved from one tree checked against a `changedFiles` gathered from another is a verification that
 * means nothing, and separate parameters are how that happens.
 */
export class AuthorizationContext {
    branch: string;
    forkPoint: string;
    changedFiles: string[];
    now: Date;

    constructor(branch: string, forkPoint: string, changedFiles: string[] = [], now: Date = new Date()) {
        this.branch = branch;
        this.forkPoint = forkPoint;
        this.changedFiles = changedFiles;
        this.now = now;
    }
}

/**
 * The verdict on ONE approval. `ok` false ⇒ `reason` says WHICH of the four bindings failed, in the
 * human's terms, because that is the sentence the agent has to relay back to them. Data-only.
 */
export class AuthorizationCheck {
    ok: boolean;
    reason: string;               // '' when ok
    approval: HumanApproval | null;

    constructor(ok: boolean, reason: string, approval: HumanApproval | null) {
        this.ok = ok;
        this.reason = reason;
        this.approval = approval;
    }
}

/**
 * What a branch is actually authorized to override RIGHT NOW: checklist id → the human's `approves` prose.
 * Data-only, with accessors so every consumer asks the question one way.
 *
 * `rejected` carries the approvals that were found but did NOT verify, one rendered line each. They are
 * kept rather than dropped because "there is an approval on this branch, and here is why it no longer
 * counts" is a completely different message from "nobody has authorized anything" — the first needs a
 * re-authorization, the second needs a human at all — and an empty map cannot tell them apart.
 */
export class AuthorizedOverrides {
    proseById: Map<string, string>;
    rejected: string[];

    constructor(proseById: Map<string, string> = new Map<string, string>(), rejected: string[] = []) {
        this.proseById = proseById;
        this.rejected = rejected;
    }

    has(checklistId: string): boolean {
        return this.proseById.has(checklistId);
    }

    /** The human's own words for `checklistId`, or '' when it is not authorized. */
    proseFor(checklistId: string): string {
        return this.proseById.get(checklistId) ?? '';
    }
}

/**
 * Mints (for a HUMAN at a tty) and verifies (for ANYONE, agents included) the human-authorization records
 * that are the ONLY channel by which a review checklist's override may be granted.
 *
 * ─── The problem ───────────────────────────────────────────────────────────────────────────────────────
 * A required checklist goes red, the human authorizes the partial scope, and there is NO channel by which
 * the subagent doing the work can know that. Every channel available before this carried a CLAIM of
 * authorization and never EVIDENCE of it: a coordinator relaying the human's words is unverifiable by
 * construction (and correctly refused — that refusal is the shape a prompt injection exploits); a ticket
 * comment can be written by an agent holding the same MCP; and the `override` field in review-<id>.json is
 * the agent authorizing itself.
 *
 * So the property this class buys is exactly one sentence: **an agent can VERIFY an authorization it
 * cannot MINT.** `wp-authorize` reads the approval from `/dev/tty`, which an agent's Bash tool has no way
 * to answer; `wp-check-auth` recomputes the HMAC and is read-only, so agents run it freely.
 *
 * ─── Bound to SCOPE, never to a diff sha ───────────────────────────────────────────────────────────────
 * An approval bound to the head-commit diff would be void on the next commit, so the human would
 * re-authorize on every push and nobody would use it. Each approval binds to WHAT WAS APPROVED instead:
 *   • `scopePaths` — the globs the diff touched when approved. A "terraform only" approval is void the
 *     moment app files appear, which is the abuse actually worth stopping.
 *   • `forkPoint`  — the merge-base when approved. Survives new commits; dies if the branch is restarted.
 *   • `expiresAt`  — hours, not days.
 * Edits inside the approved scope keep working; widening it does not. That is what the human means when
 * they say "yes, ship the terraform half".
 *
 * ─── Where the file lives, and why it is SHARED rather than per-worktree ───────────────────────────────
 * `dotWebpieces.shared()/authorizations/<branch-slug>.json`, keyed by BRANCH. Not `local()`: the human
 * routinely types `wp-authorize` in the primary clone while the agent works in a linked worktree, and
 * under `local()` those are two different files — the approval would be minted somewhere the agent never
 * looks, which is the same stall this feature exists to end. The branch key is what makes sharing safe:
 * an approval names its branch inside the SIGNED payload, so a file copied to another branch does not
 * verify there.
 *
 * It is never committed (`.webpieces/` is gitignored in full). A committed authorization would travel to
 * branches nobody approved.
 *
 * ─── Honest limits — do not oversell this ─────────────────────────────────────────────────────────────
 * The agent runs as the SAME OS USER as the human, and the HMAC key is `prGate.gateSalt`, which lives in a
 * committed file agents read routinely. Nothing here is cryptographically airtight against a determined
 * model; the real enforcement is the tty affordance plus the harness deny rule. That is fine, because the
 * problem being solved is agents drifting, guessing, or being confused by relays — not an adversarial
 * model. Moving the key to `~/.webpieces/authorize.key` is a one-line change to `sign()` if the threat
 * model ever changes; nothing else in the design moves.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class HumanAuthorizationService {
    constructor(private readonly dotDir: DotWebpieces = dotWebpieces) {}

    /** The repo-wide authorizations directory. See the class docstring for why `shared()` and not `local()`. */
    dirFor(repoRoot: string): string {
        return this.dotDir.sharedFile(repoRoot, AUTHORIZATIONS_DIR);
    }

    /**
     * A filesystem-safe leaf for a branch name. Slashes and anything exotic collapse to `-`, so
     * `dean/one-2779-grants` becomes `dean-one-2779-grants`.
     *
     * A collision between two slugs is harmless: the branch is inside the SIGNED payload, so an approval
     * that landed in a colliding file fails `verify` on the branch check rather than leaking across.
     */
    slugFor(branch: string): string {
        return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    }

    pathFor(repoRoot: string, branch: string): string {
        return path.join(this.dirFor(repoRoot), `${this.slugFor(branch)}.json`);
    }

    /**
     * The exact bytes that get signed: a version tag, the branch, and every field of the approval EXCEPT
     * the hmac, in a fixed order with `scopePaths` sorted.
     *
     * Fixed order and sorting are load-bearing — `JSON.stringify` over a re-parsed object preserves
     * insertion order, so a round-tripped approval whose keys arrived in a different order would compute a
     * different payload and fail to verify a signature that is perfectly good.
     */
    canonicalPayload(branch: string, approval: HumanApproval): string {
        return [
            PAYLOAD_VERSION,
            branch,
            approval.checklist,
            approval.gate,
            approval.approves,
            [...approval.scopePaths].sort().join(','),
            approval.forkPoint,
            approval.issuedAt,
            approval.expiresAt,
        ].join('\n');
    }

    /** `HMAC-SHA256(salt, canonical payload)`. '' for an empty salt — the caller treats '' as "not configured". */
    sign(branch: string, approval: HumanApproval, salt: string): string {
        if (salt.trim() === '') return '';
        return createHmac('sha256', salt).update(this.canonicalPayload(branch, approval)).digest('hex');
    }

    /** The same approval, carrying its signature. Never mutates the input. */
    signed(branch: string, approval: HumanApproval, salt: string): HumanApproval {
        return new HumanApproval(
            approval.checklist, approval.gate, approval.approves, approval.scopePaths,
            approval.forkPoint, approval.issuedAt, approval.expiresAt,
            this.sign(branch, approval, salt),
        );
    }

    /**
     * Every approval recorded for `branch`, signature UNCHECKED. An absent or unreadable file is an EMPTY
     * file, never a throw: a corrupt authorization must degrade to "nothing is authorized", which is the
     * safe direction, and a branch that cannot open its own authorization file must still be able to run
     * the gate and be told to go get one.
     */
    load(repoRoot: string, branch: string): AuthorizationFile {
        const p = this.pathFor(repoRoot, branch);
        if (!fs.existsSync(p)) return new AuthorizationFile(branch);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: unreadable authorizations mean "none", never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until each field is narrowed below
            const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
            const list = Array.isArray(raw['approvals']) ? (raw['approvals'] as unknown[]) : [];
            return new AuthorizationFile(branch, list.map((e: unknown): HumanApproval => this.toApproval(e)));
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return new AuthorizationFile(branch);
        }
    }

    // One parsed entry. Every field is read defensively — a hand-edited file is exactly the input this must
    // survive, and a missing field simply yields '' / [], which then fails the signature check.
    // webpieces-disable no-any-unknown -- opaque parsed JSON entry; each field is narrowed here
    private toApproval(entry: unknown): HumanApproval {
        const raw = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
        return new HumanApproval(
            this.str(raw['checklist']), this.str(raw['gate']), this.str(raw['approves']),
            this.strList(raw['scopePaths']), this.str(raw['forkPoint']),
            this.str(raw['issuedAt']), this.str(raw['expiresAt']), this.str(raw['hmac']),
        );
    }

    // webpieces-disable no-any-unknown -- reading ONE opaque field out of hand-editable JSON; narrowed right here
    private str(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }

    // webpieces-disable no-any-unknown -- reading ONE opaque field out of hand-editable JSON; narrowed right here
    private strList(value: unknown): string[] {
        if (!Array.isArray(value)) return [];
        // webpieces-disable no-any-unknown -- element of an opaque JSON array, narrowed by the type guard
        return value.filter((v: unknown): v is string => typeof v === 'string');
    }

    /**
     * APPEND one signed approval to the branch's file and return the path written. Append, never replace:
     * a run of work needs several overrides at different times, and each one is its own record of intent.
     */
    append(repoRoot: string, branch: string, approval: HumanApproval, salt: string): string {
        const file = this.load(repoRoot, branch);
        file.approvals.push(this.signed(branch, approval, salt));
        const p = this.pathFor(repoRoot, branch);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(new AuthorizationFile(branch, file.approvals), null, 2) + '\n');
        return p;
    }

    /**
     * Verify ONE approval against the branch state, in the order a reader wants to hear it: signature,
     * expiry, fork point, scope. Signature first — an unsigned entry's other fields are not evidence of
     * anything, and reporting "expired" for a forged record would be answering the wrong question.
     */
    verify(ctx: AuthorizationContext, approval: HumanApproval, salt: string): AuthorizationCheck {
        const expected = this.sign(ctx.branch, approval, salt);
        if (expected === '' || approval.hmac !== expected) {
            return this.fail(approval, 'its signature does not verify — it was hand-written, edited after '
                + 'signing, minted on a different branch, or the repo\'s prGate.gateSalt changed');
        }
        if (this.expired(approval, ctx.now)) {
            return this.fail(approval, `it EXPIRED at ${approval.expiresAt} (an approval is for the sitting it was given in)`);
        }
        if (approval.forkPoint !== '' && ctx.forkPoint !== '' && approval.forkPoint !== ctx.forkPoint) {
            return this.fail(approval, `the branch was restarted from a different base — approved at fork point `
                + `${approval.forkPoint.slice(0, 12)}, now ${ctx.forkPoint.slice(0, 12)}`);
        }
        const outside = this.outsideScope(approval, ctx.changedFiles);
        if (outside.length > 0) {
            return this.fail(approval, `the diff now touches ${outside.length} file(s) OUTSIDE the approved scope `
                + `(${approval.scopePaths.join(', ')}): ${outside.slice(0, 5).join(', ')}`);
        }
        return new AuthorizationCheck(true, '', approval);
    }

    private fail(approval: HumanApproval, reason: string): AuthorizationCheck {
        return new AuthorizationCheck(false, reason, approval);
    }

    // An approval with no parseable `expiresAt` is treated as EXPIRED. Failing closed is the only safe
    // reading: a missing expiry on a record whose whole purpose is to be time-bounded is a broken record,
    // and the alternative reading is a grant that never ends.
    private expired(approval: HumanApproval, now: Date): boolean {
        const at = Date.parse(approval.expiresAt);
        if (Number.isNaN(at)) return true;
        return at <= now.getTime();
    }

    /**
     * The changed files NOT covered by `scopePaths`. An approval with an EMPTY `scopePaths` covers nothing
     * and is therefore always out of scope when anything changed — `wp-authorize` never mints one, and the
     * alternative reading ("empty means everything") is precisely the widening-by-absence that makes the
     * permissive path the shortest thing to type.
     */
    private outsideScope(approval: HumanApproval, changedFiles: readonly string[]): string[] {
        return changedFiles.filter((f: string): boolean => !matchesAnyGlob(f, approval.scopePaths));
    }

    /**
     * THE question every consumer asks: what is this branch authorized to override right now? Verifies every
     * recorded approval and returns the ones that hold, plus a rendered line per one that does not.
     *
     * Later approvals win for the same checklist — the human appended it because they meant to say something
     * newer, and the file is append-only precisely so the earlier one stays readable as history.
     */
    verifiedFor(repoRoot: string, ctx: AuthorizationContext, salt: string): AuthorizedOverrides {
        const prose = new Map<string, string>();
        const rejected: string[] = [];
        for (const approval of this.load(repoRoot, ctx.branch).approvals) {
            const check = this.verify(ctx, approval, salt);
            if (check.ok) prose.set(approval.checklist, approval.approves);
            else rejected.push(`"${approval.checklist}" (issued ${approval.issuedAt}) — ${check.reason}`);
        }
        return new AuthorizedOverrides(prose, rejected);
    }

    /** An expiry `hours` from `issuedAt`, as ISO — the one place the TTL arithmetic lives. */
    expiryFrom(issuedAt: Date, hours: number): string {
        return new Date(issuedAt.getTime() + hours * 3600 * 1000).toISOString();
    }
}
