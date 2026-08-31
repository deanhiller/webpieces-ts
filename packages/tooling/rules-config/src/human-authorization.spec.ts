import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AuthorizationContext, AuthorizedOverrides, HumanApproval, HumanAuthorizationService,
} from './human-authorization';
import {
    CK_FAIL, CK_OVERRIDDEN, CK_UNAUTHORIZED, ChecklistResult, RequiredChecklist, ReviewJsonService,
} from './review-json';

const SALT = 'e1e2e3e4e5e6e7e8e9eae1e2e3e4e5e6e7e8e9eae1e2e3e4e5e6e7e8e9eae1e2';
const BRANCH = 'dean-one-2779-tf-grants';
const FORK = '7f6393d0aa11bb22cc33dd44ee55ff6677889900';

function repo(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-auth-')));
}

function inHours(hours: number): string {
    return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function approval(scopePaths: string[] = ['terraform/**'], expiresAt: string = inHours(4)): HumanApproval {
    return new HumanApproval(
        'morpheus-wrapper-linear-required', 'gate-4-whole-ticket-delivered',
        'Ship terraform IAM grants ALONE as step 1 of 2.', scopePaths, FORK,
        new Date().toISOString(), expiresAt);
}

function ctx(changedFiles: string[]): AuthorizationContext {
    return new AuthorizationContext(BRANCH, FORK, changedFiles);
}

describe('HumanAuthorizationService — an agent can VERIFY what it cannot MINT', () => {
    it('verifies an approval it just signed, inside its scope', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        const grants = svc.verifiedFor(root, ctx(['terraform/iam.tf']), SALT);
        expect(grants.has('morpheus-wrapper-linear-required')).toBe(true);
        expect(grants.proseFor('morpheus-wrapper-linear-required')).toContain('step 1 of 2');
        expect(grants.rejected).toEqual([]);
    });

    /**
     * The whole point of the HMAC: a hand-written entry — the shape an agent would produce if it decided to
     * "just add the approval itself" — carries no valid signature and grants nothing.
     */
    it('REFUSES a hand-written approval that was never signed', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        const file = svc.pathFor(root, BRANCH);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ branch: BRANCH, approvals: [approval()] }, null, 2));
        const grants = svc.verifiedFor(root, ctx(['terraform/iam.tf']), SALT);
        expect(grants.has('morpheus-wrapper-linear-required')).toBe(false);
        expect(grants.rejected[0]).toContain('signature does not verify');
    });

    // Editing a signed record — widening `approves`, or the scope — breaks the signature it was minted with.
    it('REFUSES a signed approval whose fields were edited afterwards', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        const file = svc.pathFor(root, BRANCH);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('terraform/**', '**'));
        expect(svc.verifiedFor(root, ctx(['src/app.ts']), SALT).has('morpheus-wrapper-linear-required')).toBe(false);
    });

    // The abuse worth stopping: a "terraform only" approval must die the moment app files appear.
    it('REFUSES once the diff grows OUTSIDE the approved scope', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        const grants = svc.verifiedFor(root, ctx(['terraform/iam.tf', 'src/app.ts']), SALT);
        expect(grants.has('morpheus-wrapper-linear-required')).toBe(false);
        expect(grants.rejected[0]).toContain('OUTSIDE the approved scope');
    });

    // …while ordinary further commits INSIDE the scope keep working. This is why the binding is scope and
    // not a diff sha: bound to a sha, the human would re-authorize on every push and nobody would use it.
    it('SURVIVES new commits inside the approved scope', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        const grants = svc.verifiedFor(root, ctx(['terraform/iam.tf', 'terraform/roles/new.tf']), SALT);
        expect(grants.has('morpheus-wrapper-linear-required')).toBe(true);
    });

    it('REFUSES an expired approval', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(['terraform/**'], inHours(-1)), SALT);
        expect(svc.verifiedFor(root, ctx(['terraform/iam.tf']), SALT).rejected[0]).toContain('EXPIRED');
    });

    it('REFUSES when the branch was restarted from a different fork point', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        const moved = new AuthorizationContext(BRANCH, 'aaaabbbbccccdddd0000111122223333', ['terraform/iam.tf']);
        expect(svc.verifiedFor(root, moved, SALT).rejected[0]).toContain('restarted from a different base');
    });

    // A file copied to another branch is not an approval for that branch — the branch is inside the payload.
    it('REFUSES an approval file copied onto a DIFFERENT branch', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        fs.copyFileSync(svc.pathFor(root, BRANCH), svc.pathFor(root, 'someone-else-branch'));
        const other = new AuthorizationContext('someone-else-branch', FORK, ['terraform/iam.tf']);
        expect(svc.verifiedFor(root, other, SALT).has('morpheus-wrapper-linear-required')).toBe(false);
    });

    // Fails CLOSED: with no salt configured nothing verifies, rather than everything.
    it('grants nothing when the repo has no gateSalt', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        expect(svc.verifiedFor(root, ctx(['terraform/iam.tf']), '').has('morpheus-wrapper-linear-required')).toBe(false);
    });

    // N approvals per branch, arriving at different times — the unit of work is the branch, not the gate.
    it('holds several approvals in one file and verifies each independently', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(), SALT);
        svc.append(root, BRANCH, new HumanApproval(
            'backwards-compat-reviewer', '', 'The shim is the migration itself.', ['packages/**'], FORK,
            new Date().toISOString(), inHours(4)), SALT);
        const grants = svc.verifiedFor(root, ctx(['terraform/iam.tf']), SALT);
        expect(grants.has('morpheus-wrapper-linear-required')).toBe(true);
        // The second approval's scope does not cover this diff, so it does not silently ride along.
        expect(grants.has('backwards-compat-reviewer')).toBe(false);
    });

    it('reads an unparseable authorization file as NOTHING authorized rather than throwing', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        const file = svc.pathFor(root, BRANCH);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        expect(svc.load(root, BRANCH).approvals).toEqual([]);
    });
});

/**
 * The gate this feature exists for: `override` in review-<id>.json is written by the reviewer SUBAGENT, so
 * on its own it is an agent authorizing itself. It only ships once a human authorization verifies.
 */
describe('resolveVerdict — an override is a CLAIM until a human signed for it', () => {
    const req = new RequiredChecklist('morpheus-wrapper-linear-required', 'morpheus-wrapper', '', ['terraform/iam.tf']);
    const red = [new ChecklistResult(req.id, 'red', 'gate 4: whole ticket not delivered', 'shipping half of it, it is fine')];

    it('REFUSES a red-plus-override with no authorization (CK_UNAUTHORIZED, not CK_OVERRIDDEN)', () => {
        const verdict = new ReviewJsonService().resolveVerdict(req, red, new AuthorizedOverrides());
        expect(verdict.status).toBe(CK_UNAUTHORIZED);
    });

    it('ships it once the human authorization verifies, carrying the HUMAN\'s words', () => {
        const grants = new AuthorizedOverrides(new Map([[req.id, 'Ship the terraform half; AGENTS.md rule 6.']]));
        const verdict = new ReviewJsonService().resolveVerdict(req, red, grants);
        expect(verdict.status).toBe(CK_OVERRIDDEN);
        expect(verdict.detail).toContain('HUMAN APPROVED: Ship the terraform half');
    });

    // An authorization for a DIFFERENT checklist must not launder this one through.
    it('does not honour an authorization issued for another checklist', () => {
        const grants = new AuthorizedOverrides(new Map([['backwards-compat-reviewer', 'unrelated']]));
        expect(new ReviewJsonService().resolveVerdict(req, red, grants).status).toBe(CK_UNAUTHORIZED);
    });

    it('still reports a plain red with no override as CK_FAIL — a different problem, a different action', () => {
        const plain = [new ChecklistResult(req.id, 'red', 'gate 4: whole ticket not delivered', '')];
        expect(new ReviewJsonService().resolveVerdict(req, plain, new AuthorizedOverrides()).status).toBe(CK_FAIL);
    });

    /**
     * The refusal must send the reader to a HUMAN, not back to the code. Telling this reader to "fix the
     * finding" sends them to re-do work a person may already have decided to accept — and telling them to
     * "get an override" is exactly what they already, wrongly, did.
     */
    it('names wp-authorize (for the human) and wp-check-auth (for the agent) in the refusal', () => {
        const svc = new ReviewJsonService();
        const text = svc.refusalError(req, svc.resolveVerdict(req, red, new AuthorizedOverrides()));
        expect(text).toContain('NO HUMAN AUTHORIZED');
        expect(text).toContain('pnpm wp-authorize --checklist morpheus-wrapper-linear-required');
        expect(text).toContain('pnpm wp-check-auth --checklist morpheus-wrapper-linear-required');
        expect(text).toContain('ASK THE HUMAN');
    });

    // Rule 6 of the compatibility policy: no message may teach the channel that was removed.
    it('no longer teaches "set an override in review-<id>.json" as the escape hatch', () => {
        const svc = new ReviewJsonService();
        const plain = [new ChecklistResult(req.id, 'red', 'found a real problem', '')];
        const text = svc.refusalError(req, svc.resolveVerdict(req, plain, new AuthorizedOverrides()));
        expect(text).not.toContain('set a non-empty "override"');
        expect(text).toContain('a HUMAN must authorize it');
    });

    // The reviewer's own schema must not invite it to fill the field in either.
    it('tells reviewers to leave "override" empty, because it is not theirs to fill in', () => {
        const schema = new ReviewJsonService().verdictSchemaFor('some-reviewer');
        expect(schema).toContain('Leave "override" as ""');
        expect(schema).toContain('wp-authorize');
    });
});

/**
 * The dotfile trap, pinned here because it is invisible: minimatch hides a `.`-leading segment from a
 * wildcard by default, so before `{ dot: true }` an approval scoped to `**` did NOT cover
 * `.github/workflows/deploy.yml` — and the approval died for a reason nobody standing at the prompt could
 * have predicted. `.github/`, `.claude/` and `.webpieces/` are ordinary directories in these repos.
 */
describe('scope matching covers dot-directories', () => {
    it('a scope covering the repo covers .github and .claude paths too', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(['**']), SALT);
        const files = ['.github/workflows/deploy.yml', '.claude/agents/x.md', 'src/a.ts'];
        expect(svc.verifiedFor(root, ctx(files), SALT).has('morpheus-wrapper-linear-required')).toBe(true);
    });

    it('a narrow scope still refuses a dot-path outside it', () => {
        const svc = new HumanAuthorizationService();
        const root = repo();
        svc.append(root, BRANCH, approval(['terraform/**']), SALT);
        const grants = svc.verifiedFor(root, ctx(['terraform/iam.tf', '.github/workflows/deploy.yml']), SALT);
        expect(grants.has('morpheus-wrapper-linear-required')).toBe(false);
    });
});
