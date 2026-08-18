import { execSync } from 'child_process';
import * as fs from 'fs';

import { InformAiError } from './inform-ai-error';
import { RuleFailError } from './rule-fail-error';
import { Option } from './fix-option';
import { toError } from './to-error';

// Universal "should this rule be skipped right now?" logic, shared by code-rules,
// ai-hook-rules and the Nx executors so every rule honors the same two escape
// hatches: turnOffRuleWhileOnBranch (skip while on a named branch) and
// turnOffRuleUntilEpoch (skip until an epoch passes).

/**
 * The skip decision. A CLASS, not an interface (CLAUDE.md rule 1), because it carries a THIRD fact
 * beyond yes/no that a caller has to be able to read rather than read about in a log line.
 *
 * `hatchNotApplied` is that fact: a branch hatch WAS configured, and it could NOT apply — today only
 * because HEAD is detached (a tag checkout, a `git bisect` step, a CI checkout of a merge ref). The rule
 * is ENFORCED in that case, so there is nothing to report unless the rule then FAILS; when it does, its
 * own RuleFailError is where this belongs, as context on why the hatch the config shows did not save it.
 *
 * It is deliberately NOT printed here. Everything in this framework throws to ONE place that renders per
 * audience; a console write from a library function cannot be caught, re-rendered or asserted on.
 */
export class SkipRuleResult {
    skip: boolean;
    /** Why the rule IS being skipped. '' whenever `skip` is false. */
    reason: string;
    /** Why a CONFIGURED branch hatch did not apply, or '' when there is nothing to say. */
    hatchNotApplied: string;

    constructor(skip: boolean, reason: string = '', hatchNotApplied: string = '') {
        this.skip = skip;
        this.reason = reason;
        this.hatchNotApplied = hatchNotApplied;
    }
}

// The actual checked-out branch. The grab bag of ambient env vars (BRANCH_NAME, GIT_BRANCH,
// CI_COMMIT_BRANCH, …) was intentionally REMOVED and must stay removed: a stray GIT_BRANCH=main
// locally made this return "main" on a feature branch, which (a) mislabeled the main-sync cache and
// (b) silently disabled merged-PR detection (detectMergedPr skips "main").
//
// The two vars below are NOT that. They are consulted BEFORE git because git cannot answer at all in
// the case they cover — a `pull_request` checkout leaves HEAD detached on refs/pull/<N>/merge, where
// `git rev-parse --abbrev-ref HEAD` returns the literal string "HEAD" and no branch hatch can match.
// Neither can go stale the way GIT_BRANCH did:
//   GITHUB_HEAD_REF  — set by the GitHub runner ONLY on pull_request/pull_request_target, and it IS
//                      the source branch name. Absent on push, so the fallthrough stays safe. (Not
//                      GITHUB_REF_NAME: on pull_request that is "<N>/merge", not a branch.)
//   WEBPIECES_BRANCH — one documented opt-in override for CI systems not special-cased here
//                      (GitLab, CircleCI, Buildkite). Nobody sets it by accident.
//
// This getter answers "what branch am I on?" and NOTHING about whether that answer may be TRUSTED to
// unlock an escape hatch. That second question is asked by shouldSkipRule alone (see
// assertBranchIsTrustworthy) because this getter has callers — the main-sync cache label, merged-PR
// detection, code-rules' re-export of it — for which a fork's own branch name is a perfectly good
// answer, and making the getter itself throw would redden all of them.
export function getCurrentBranch(): string {
    const prBranch = process.env['GITHUB_HEAD_REF'];
    if (prBranch) return prBranch;

    const override = process.env['WEBPIECES_BRANCH'];
    if (override) return override;

    // webpieces-disable no-unmanaged-exceptions -- rethrow as InformAiError so global catch surfaces readable message to AI
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrow as InformAiError so global catch surfaces readable message to AI
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(`Failed to determine current git branch: ${error.message}`, { cause: error });
    }
}

// The slice of the GitHub `pull_request` event payload that says WHO OWNS the head branch. Only the
// one field below is read; everything else in that file is ignored.
interface RawPullRequestEvent {
    pull_request?: {
        head?: {
            repo?: {
                full_name?: string;
            };
        };
    };
}

/**
 * Refuse the branch hatch on a pull request whose head branch this repo does not own.
 *
 * The hole it closes: hatch names live in `webpieces.config.json`, which is COMMITTED and public. On a
 * `pull_request` from a FORK the runner sets GITHUB_HEAD_REF to the FORK AUTHOR's branch name, so an
 * outside contributor who names their branch after one of your hatches silently disables that rule on
 * their PR — the one place you least want a rule off.
 *
 * It is answered with no network and no token, from `$GITHUB_EVENT_PATH` — a JSON file the runner writes
 * before the job starts:
 *   - `pull_request_target` runs with the BASE repo's secrets against contributor-authored code, so it is
 *     untrusted unconditionally; there is nothing to compare.
 *   - `pull_request` is trusted only when the head repo's `full_name` EQUALS `GITHUB_REPOSITORY`.
 *
 * "Cannot tell" counts as untrusted — a `pull_request` run with no readable event file cannot make the
 * comparison, and a hatch that cannot be proven to be yours must not fire.
 *
 * This is the ONE hard failure left in this module, and it is not the "no branch here" case (see
 * shouldSkipRule, which enforces quietly when HEAD is detached). It is a hatch name that DOES resolve but
 * is attacker-chosen — a security property, not a checkout that happens not to be editing.
 *
 * Called ONLY from inside `if (branchName)`. With turnOffRuleWhileOnBranch null — the overwhelmingly
 * common value — nothing here runs and no fork PR is affected in any way.
 */
// webpieces-disable no-function-outside-class -- module-scope helper of the module-scope shouldSkipRule it serves; this whole module is functional by design (imported as free functions by code-rules, ai-hook-rules and the nx executors)
function assertBranchIsTrustworthy(branchName: string): void {
    const eventName = process.env['GITHUB_EVENT_NAME'];
    if (eventName !== 'pull_request' && eventName !== 'pull_request_target') return;
    if (eventName === 'pull_request_target') throw forkRefusal(branchName, 'pull_request_target run');

    const headRepo = readHeadRepoFullName(branchName);
    const thisRepo = process.env['GITHUB_REPOSITORY'] ?? '';
    if (headRepo !== null && thisRepo !== '' && headRepo === thisRepo) return;
    throw forkRefusal(branchName, headRepo === null
        ? 'pull_request run with no readable $GITHUB_EVENT_PATH, so the head branch cannot be proven to belong to this repo'
        : `pull_request run whose head branch lives in "${headRepo}", not in "${thisRepo}"`);
}

/**
 * The head repo's `owner/name` from the runner's event file, or null when there is no such file.
 *
 * A file that exists but cannot be parsed is a different thing from one that is absent, and it throws:
 * it means the runner wrote something this code does not understand, and silently downgrading that to
 * "untrusted" would hide a real incompatibility behind a message about forks.
 */
// webpieces-disable no-function-outside-class -- module-scope helper, see assertBranchIsTrustworthy
function readHeadRepoFullName(branchName: string): string | null {
    const eventPath = process.env['GITHUB_EVENT_PATH'];
    if (!eventPath || !fs.existsSync(eventPath)) return null;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: a raw SyntaxError from the runner's event file would say nothing about hatches; this names the hatch, the file and the rule that stayed ON
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- see above
    try {
        const parsed = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as RawPullRequestEvent;
        return parsed.pull_request?.head?.repo?.full_name ?? null;
    } catch (err: unknown) {
        const error = toError(err);
        throw new RuleFailError(
            'turnOffRuleWhileOnBranch',
            `turnOffRuleWhileOnBranch: "${branchName}" is configured and this is a pull_request run, so the ` +
                `head repository must be checked before the hatch may fire — but the runner's event file ` +
                `${eventPath} could not be read: ${error.message}`,
            undefined,
            undefined,
            [new Option('Use turnOffRuleUntilEpoch instead — it is TIME based and needs no event file.', true),
             new Option('Or clear turnOffRuleWhileOnBranch (set it to null) so no trust check is needed at all.')],
            undefined,
            error);
    }
}

/**
 * The fork refusal, as a `RuleFailError`.
 *
 * The cures are `fixOptions` — a LIST of `Option` — because the framework owns how they are labelled
 * and numbered (`formatFixOptions` renders "Fix Option N:" and the "(preferred)" tag for BOTH engines).
 * A hand-numbered "WORKAROUNDS: 1. … 2. …" string literal, which is what this used to be, is exactly
 * the shape `Option` exists to prevent. `Option` lives HERE in `rules-config`, so the same class serves
 * this build-time throw and `FixHint` in `ai-hook-rules` — one cure shape, one definition.
 *
 * `ruleName` is the HATCH, not the rule being evaluated: `shouldSkipRule` is handed only the two hatch
 * values and does not know whose rule it is deciding for — and the thing that failed genuinely is the
 * hatch, which cannot be honored here.
 */
// webpieces-disable no-function-outside-class -- module-scope helper, see assertBranchIsTrustworthy
function forkRefusal(branchName: string, what: string): RuleFailError {
    return new RuleFailError(
        'turnOffRuleWhileOnBranch',
        `turnOffRuleWhileOnBranch: "${branchName}" is configured, but this is a ${what}. The branch name ` +
            `there is chosen by the PULL REQUEST AUTHOR, and hatch names are public (webpieces.config.json ` +
            `is committed), so honoring the hatch would let anyone turn this rule off on their own PR just ` +
            `by naming their branch after it. The rule is NOT skipped, and this fails loudly rather than ` +
            `quietly enforcing a rule the config says is off.`,
        undefined,
        undefined,
        [
            new Option(
                'If the rule must be off for outside contributions too, use turnOffRuleUntilEpoch — it is TIME ' +
                    'based, so it cannot be self-granted by naming a branch. Keep the date short: it is repo-wide ' +
                    'while it lasts, so it also shelters unrelated work landing in the same window.',
                true,
            ),
            new Option(
                'Otherwise clear turnOffRuleWhileOnBranch (set it to null) and fix the findings on the ' +
                    'contributed branch like any other.',
            ),
        ],
    );
}

export function shouldSkipRule(
    epoch: number | undefined,
    // The branch hatch is an EXACT branch name — compared with `===`, never a glob, regex or prefix.
    // That is deliberate and is not to be "improved": the hatch turns a rule OFF, and a pattern lets one
    // config line switch rules off on branches nobody enumerated when it was written. If two branches
    // need the same rule off, that is two branches renamed to one hatch name, not one wildcard.
    //
    // null (the "no branch / always on" value of turnOffRuleWhileOnBranch) is treated exactly like
    // undefined — no branch scoping. Only a non-empty branch name activates the branch hatch.
    branchName: string | undefined | null
): SkipRuleResult {
    if (branchName) {
        // The fork gate fires ONLY inside `if (branchName)`. With turnOffRuleWhileOnBranch=null — the
        // overwhelmingly common value — nothing below runs, so an outside contribution to a repo that
        // configured no hatch is an ordinary run.
        //
        // A DETACHED HEAD is NOT an error here. The branch hatch exists to relax a rule while you EDIT on
        // a branch; a tag checkout or a `git bisect` step is not editing (you cannot commit to a tag, and
        // to edit you branch off it first). So when no branch can be resolved the hatch simply does not
        // apply and THE RULE IS ENFORCED — whoever hits a violation then gets that rule's own message and
        // cure, which is the useful output. WHY the hatch did not fire rides back on the result
        // (SkipRuleResult.hatchNotApplied) rather than being printed, so a caller that does fail can fold
        // it into its own error instead of a library writing to a console nobody can catch.
        assertBranchIsTrustworthy(branchName);
        const current = getCurrentBranch();
        if (current === 'HEAD' || current === '') {
            return new SkipRuleResult(false, '',
                `turnOffRuleWhileOnBranch: "${branchName}" did not apply — HEAD is detached, so there is no ` +
                `branch to match (a tag checkout, a git bisect step, or a CI checkout of a merge ref).`);
        }
        if (current === branchName) {
            return new SkipRuleResult(true, `on branch "${branchName}"`);
        }
    }
    if (epoch !== undefined) {
        const nowSeconds = Date.now() / 1000;
        if (nowSeconds < epoch) {
            const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
            return new SkipRuleResult(true, `turnOffRuleUntilEpoch active, expires: ${expiresDate}`);
        }
    }
    return new SkipRuleResult(false);
}
