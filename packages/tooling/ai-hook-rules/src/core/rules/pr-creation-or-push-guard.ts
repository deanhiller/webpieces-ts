import {
    DEFAULT_DEV_BRANCH,
    DEFAULT_DEV_BRANCH_NAMESPACE,
    PrCreationOrPushGuardConfig,
    RepoRootFinder,
    WP_PUSH_DEV,
    loadAndValidate,
    writeTemplate,
} from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase } from '../rule-base';
import { FixHint } from '../fix-hint';

const DEFAULT_UPSERT_PR_COMMAND = 'pnpm wp-start-upsert-pr';
const INSTRUCT_FILE = 'webpieces.git-workflow.md';

/**
 * The hint BRANCHES ON INTENT, and that is not polish.
 *
 * There are now two legitimate destinations for a blocked push — land it on `main`, or get it onto the
 * shared dev server — and the block alone cannot tell them apart. The old flat hint said "everything goes
 * through `wp-start-upsert-pr`", so an AI told "put my branch on dev" would try `git push`, get blocked,
 * read this, and open a PR to main: the exact opposite of what it was asked to do, and the destructive
 * direction of the two. Naming both destinations is what makes the dev flow discoverable at all — nothing
 * else the AI can see mentions it.
 */
function fixHintFor(upsertPrCommand: string): FixHint {
    return new FixHint(
        'Direct PR creation/update AND manual `git push` are blocked.',
        'Never push or open/update a PR by hand. There are TWO gated destinations — pick by what you were\n'
        + 'actually trying to do:\n\n'
        + 'LANDING ON MAIN (a PR, prod-quality, reviewed):\n'
        + `  ${upsertPrCommand}\n`
        + '  It updates the branch from main (3-point merge) and runs the real build (nx affected), then\n'
        + '  instructs you to write review.json and run `pnpm wp-finish-upsert-pr`, which assembles the\n'
        + '  dashboard and creates/updates the PR — and pushes for you. A failing build = no push, no PR.\n\n'
        + 'JUST WANT IT ON THE SHARED DEV SERVER (no PR, not landing on main):\n'
        + `  ${WP_PUSH_DEV}\n`
        + '  It publishes a DISPOSABLE copy of your branch that the dev environment composes and rebuilds.\n'
        + '  Your feature branch is never moved and never acquires another developer\'s commits, which is\n'
        + '  the whole reason the copy exists. Do NOT open a PR to main just to test something in dev.\n\n'
        + 'Both push internally as child processes this hook never sees, so the gated commands are\n'
        + 'unaffected by this guard. There is nothing to paste or attest to; the commands do the work.\n'
        + 'If a HUMAN genuinely needs an out-of-band push (neither destination above), do NOT do it\n'
        + 'yourself — ask them to run the push, since a manual push bypasses the build gate, review.json,\n'
        + 'and dashboard.\n'
        + 'Full branch → update → PR flow: READ the instruct-ai git-workflow doc at the absolute path on the violation line above.\n'
        + 'Add this to your memory so you don\'t forget next time and waste tokens.',
    );
}

// Detect every way an agent could push or open/update a PR directly, so the ONLY path left is the
// gated flow (wp-start-upsert-pr → wp-finish-upsert-pr, whose internal `git push` / `gh pr create`
// run as child processes the hook never sees). Read-only `gh pr list` / `gh api .../pulls` GET are
// intentionally allowed.
function isBlockedPrOrPush(cmd: string): boolean {
    // A manual push is always blocked — the gated flow pushes for you behind the build gate.
    if (/\bgit\s+push\b/.test(cmd)) return true;

    if (/\bgh\s+pr\s+(create|edit)\b/.test(cmd)) return true;

    const ghApiPulls = /\bgh\s+api\b[^\n]*\/pulls\b/.test(cmd);
    if (ghApiPulls && (/--method\s+POST/i.test(cmd) || /-X\s+POST/i.test(cmd) || /\s-f\b/.test(cmd) || /\s-F\b/.test(cmd) || /--field\b/.test(cmd))) {
        return true;
    }

    const curlPulls = /\bcurl\b[^\n]*api\.github\.com[^\n]*\/pulls\b/.test(cmd);
    if (curlPulls && (/-X\s*POST/i.test(cmd) || /--request\s+POST/i.test(cmd) || /(\s-d\b|--data\b)/.test(cmd))) {
        return true;
    }
    return false;
}

function truncate(s: string): string {
    const MAX = 120;
    return s.length <= MAX ? s : s.slice(0, MAX) + '…';
}

/**
 * Does this blocked push AIM at the shared dev environment?
 *
 * The refspec is the one place the AI already stated its intent unambiguously, so reading it is strictly
 * better than making the AI choose between two hints it has no way to disambiguate. A push whose
 * destination is the dev namespace or the dev branch itself gets the `wp-push-dev` remedy on the `→`
 * line; everything else keeps the PR-flow remedy it has always had.
 */
// webpieces-disable no-function-outside-class -- module-level guard helper, matches the rest of this file
function targetsDevEnvironment(cmd: string, namespace: string, devBranch: string): boolean {
    if (cmd.includes(`${namespace}/`)) return true;
    const push = /\bgit\s+push\b([^\n;&|]*)/.exec(cmd);
    if (push === null) return false;
    // Split on whitespace AND `:` so both halves of a `HEAD:<dest>` refspec are examined. Matching whole
    // tokens (never a substring) keeps a branch merely NAMED `develop` from reading as the dev branch.
    return push[1].split(/[\s:]+/).some(
        (token: string): boolean => token === devBranch || token === `refs/heads/${devBranch}`);
}

export class PrCreationOrPushGuardRule extends BashRuleBase<PrCreationOrPushGuardConfig> {
    private readonly upsertPrCommand: string;

    constructor(config: PrCreationOrPushGuardConfig) {
        super(config, 'pr-creation-or-push-guard');
        this.upsertPrCommand = config.upsertPrCommand ?? DEFAULT_UPSERT_PR_COMMAND;
    }

    readonly description = 'Block manual `git push` and direct PR creation/edit (gh pr / gh api / curl) so pushes and PRs go only through the gated upsert-pr command.';
    get fixHint(): FixHint { return fixHintFor(this.upsertPrCommand); }

    check(ctx: BashContext): readonly Violation[] {
        if (!isBlockedPrOrPush(ctx.commandCode)) return [];
        // Materialize the doc we are about to send the AI to. Pointing at a path that does not exist
        // (nothing has run a `wp-*` command in this tree yet) costs the AI a turn to discover; a STALE
        // copy from an older @webpieces is just as bad, so overwrite rather than write-if-missing.
        writeTemplate(ctx.workspaceRoot, INSTRUCT_FILE);
        const docPath = new RepoRootFinder().instructAiDocPath(ctx.workspaceRoot, INSTRUCT_FILE);
        if (this.aimedAtDevEnvironment(ctx)) {
            return [new V(1, truncate(ctx.command),
                'Manual push is blocked — but this one is aimed at the shared DEV environment, which has its own\n'
                + `gated command. Use \`${WP_PUSH_DEV}\` (publishes a disposable copy; never moves your branch, never\n`
                + `opens a PR). Do NOT use ${this.upsertPrCommand} for this — that lands on main. Full flow: READ ${docPath}.`)];
        }
        return [new V(1, truncate(ctx.command),
            `Manual push / direct PR is blocked — use the gated flow (${this.upsertPrCommand}). Full flow: READ ${docPath}.`)];
    }

    /**
     * Read the configured dev refs, falling back to the defaults when this repo has no `pr-gate` section
     * at all (a consumer that has not adopted the gate still gets a correct hint for the default names).
     *
     * Calling the loader here is safe by construction: an INVALID config blocks every Bash call long
     * before a rule runs, so reaching this line already means the config loaded.
     */
    private aimedAtDevEnvironment(ctx: BashContext): boolean {
        const devDeploy = loadAndValidate(ctx.governedRoot).prGate.devDeploy;
        return targetsDevEnvironment(
            ctx.commandCode,
            devDeploy.branchNamespace === '' ? DEFAULT_DEV_BRANCH_NAMESPACE : devDeploy.branchNamespace,
            devDeploy.devBranch === '' ? DEFAULT_DEV_BRANCH : devDeploy.devBranch);
    }
}
