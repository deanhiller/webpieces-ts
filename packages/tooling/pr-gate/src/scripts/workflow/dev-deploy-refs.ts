import { CliExitError, DevDeployConfig, loadAndValidate } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { gitCheckout } from '@webpieces/tooling-common';

import { GitExec } from './git-exec';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
const MAIN = 'main';
const DETACHED = 'HEAD';

/**
 * One live copy in the dev namespace: the remote ref and the sha it points at. Data-only per CLAUDE.md —
 * `--list` prints it, and should not be re-parsing `ls-remote` output.
 */
export class DevCopy {
    /** The full ref name WITHOUT `refs/heads/`, e.g. `dev-include/dean/ONE-2275`. */
    ref: string;
    sha: string;
    /** The feature branch this is a copy OF — `ref` with the namespace prefix stripped. */
    sourceBranch: string;

    constructor(ref: string, sha: string, sourceBranch: string) {
        this.ref = ref;
        this.sha = sha;
        this.sourceBranch = sourceBranch;
    }
}

/**
 * Ref derivation and preconditions for the dev-deploy flow — the half that decides WHICH refs are in play,
 * kept out of the commands so `wp-start-push-dev`, `wp-build-push-dev` and `wp-finish-push-dev` answer those
 * questions identically.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT: the feature branch is the PR head, so it must never acquire
 * another developer's commits — landing that PR would ship their unreviewed work to production. Every
 * write this flow performs therefore targets either the `<namespace>/<feature>` copy or a local throwaway
 * branch, and NOTHING here ever moves `<feature>` itself. That is why a conflict resolution needs the copy
 * to live in: it is the only place the resolution can be recorded without contaminating the PR.
 */
@injectable(bindingScopeValues.Singleton)
export class DevDeployRefs {
    constructor(private readonly gitExec: GitExec) {}

    /** The `pr-gate.devDeploy` block — `dev-include` / `dev` / `dev-remove` unless the consumer overrode it. */
    config(repoRoot: string): DevDeployConfig {
        return loadAndValidate(repoRoot).prGate.devDeploy;
    }

    /**
     * `commands.push-dev.buildCommand`, or `undefined` when the consumer has not configured it. There is
     * no default (#1397, `.claude/rules/no-rule-defaults.md`); DevBuild turns `undefined` into the refusal
     * that names the key.
     */
    devBuildCommand(repoRoot: string): string | undefined {
        return loadAndValidate(repoRoot).commands.pushDev.buildCommand;
    }

    /** The checked-out branch name, or `'HEAD'` on a detached HEAD (which {@link assertPushable} refuses). */
    currentBranch(repoRoot: string): string {
        return gitCheckout.requireBranch(repoRoot);
    }

    /**
     * Refuse every branch that must never be the SOURCE of a dev copy, before anything is fetched or
     * pushed.
     *
     * `main` and the composed dev branch are refused for the same reason from opposite ends: `main` is the
     * trunk (whatever is on it already deploys, so copying it is meaningless), and the dev branch is a
     * BUILD ARTIFACT that CI recomputes from `origin/main` on every run — copying it would publish a
     * composition of everyone's work under one developer's name, and it would be wiped on the next CI run
     * anyway. A branch already inside the namespace is refused because publishing a copy of a copy nests
     * the prefix (`dev-include/dev-include/…`) and nothing would ever clean it up.
     */
    assertPushable(cfg: DevDeployConfig, branch: string): void {
        if (branch === DETACHED || branch === '') {
            throw new CliExitError(2, this.refusal(
                'Detached HEAD',
                'There is no branch name to derive the dev copy from. Check out your feature branch first:\n'
                + '  git checkout <your-feature-branch>\n'));
        }
        if (branch === MAIN) {
            throw new CliExitError(2, this.refusal(
                `Refusing to publish a dev copy of \`${MAIN}\``,
                `\`${MAIN}\` is the trunk — whatever is on it already deploys, so a dev copy of it means nothing.\n`
                + 'Check out the feature branch you actually want on the dev server and re-run.\n'));
        }
        if (branch === cfg.devBranch) {
            throw new CliExitError(2, this.refusal(
                `Refusing to publish a dev copy of \`${cfg.devBranch}\``,
                `\`${cfg.devBranch}\` is a BUILD ARTIFACT, not a source branch: your CI resets it to origin/${MAIN},\n`
                + `merges every \`${cfg.copyRefGlob()}\` ref into it, and force-pushes — every run. Copying it would\n`
                + "publish a composition of everybody's work under your branch's name, and the next CI run would\n"
                + 'wipe it. Check out your own feature branch and re-run.\n'));
        }
        if (branch === cfg.branchNamespace || branch.startsWith(`${cfg.branchNamespace}/`)) {
            throw new CliExitError(2, this.refusal(
                `Refusing to publish a dev copy of a dev copy (\`${branch}\`)`,
                `\`${cfg.branchNamespace}/\` holds the disposable copies this command WRITES; you are standing on one.\n`
                + `Publishing from here would nest the prefix (\`${cfg.branchNamespace}/${branch}\`) and nothing ever\n`
                + 'cleans that up. Check out the real feature branch and re-run.\n'));
        }
    }

    /**
     * Every live copy in the namespace, sorted by ref name — what `wp-finish-push-dev --list` prints.
     */
    async liveCopies(repoRoot: string, cfg: DevDeployConfig): Promise<DevCopy[]> {
        const out = await this.gitExec.gitQuery(['ls-remote', '--heads', 'origin', cfg.copyRefGlob()], repoRoot,
            `Failed to list the dev copies (git ls-remote --heads origin '${cfg.copyRefGlob()}').`);
        const copies: DevCopy[] = [];
        for (const line of out.split('\n')) {
            if (line.trim() === '') continue;
            const fields = line.split(/\s+/);
            const sha = fields[0];
            const ref = fields[1];
            if (sha === undefined || ref === undefined || !ref.startsWith('refs/heads/')) continue;
            const shortRef = ref.slice('refs/heads/'.length);
            copies.push(new DevCopy(shortRef, sha, shortRef.slice(cfg.branchNamespace.length + 1)));
        }
        return copies.sort((a: DevCopy, b: DevCopy): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    }

    /**
     * The sha of a local ref (default HEAD).
     *
     * Read AFTER a push so the watch hints quote the sha that is provably published. Quoting the copy
     * REF instead would be a moving target — it advances the next time anybody publishes — and the whole
     * value of the "did my code land in dev" check is that it is a claim about one specific commit.
     */
    headSha(repoRoot: string, ref = 'HEAD'): Promise<string> {
        return this.gitExec.gitQuery(['-C', repoRoot, 'rev-parse', ref], repoRoot,
            `Failed to read the sha of ${ref} (git rev-parse).`);
    }

    /**
     * Fetch `origin/main` and return its sha — what the `--remove` marker points at (#1395).
     *
     * The marker carries no content, so any sha the remote already has would do; `main`'s tip is chosen
     * because it is guaranteed to exist on origin (the push sends no objects) and it is what the
     * consumer's workflow composes from anyway. Fetched rather than read from the local tracking ref, so a
     * clone that has not fetched in weeks does not point the marker at an arbitrarily old commit.
     */
    async freshMainTip(repoRoot: string): Promise<string> {
        await this.gitExec.runGitChecked(['-C', repoRoot, 'fetch', 'origin', `+refs/heads/${MAIN}:refs/remotes/origin/${MAIN}`],
            `Failed to fetch origin/${MAIN}, which the --remove marker points at. Nothing was removed`);
        return this.headSha(repoRoot, `refs/remotes/origin/${MAIN}`);
    }

    /** The remote sha of one copy, or '' when that copy does not exist yet. */
    async remoteSha(repoRoot: string, ref: string): Promise<string> {
        const out = await this.gitExec.gitQuery(['ls-remote', '--heads', 'origin', ref], repoRoot,
            `Failed to look up origin/${ref} (git ls-remote).`);
        const line = out.split('\n').find((l: string): boolean => l.trim() !== '');
        if (line === undefined) return '';
        return line.split(/\s+/)[0] ?? '';
    }

    /**
     * Fetch the named copy refs into `refs/remotes/origin/<ref>` so the local merges below run against
     * fresh state. A no-op for an empty list, and a hard failure otherwise: a resolve queued against
     * stale refs rehearses a composition CI will not build.
     */
    async fetchCopies(repoRoot: string, refs: string[]): Promise<void> {
        if (refs.length === 0) return;
        const specs = refs.map((r: string): string => `+refs/heads/${r}:refs/remotes/origin/${r}`);
        await this.gitExec.runGitChecked(['-C', repoRoot, 'fetch', 'origin', ...specs],
            'Failed to fetch the dev copy refs from origin');
    }

    private refusal(headline: string, body: string): string {
        return '\n' + SEP + `⛔ ${headline}\n` + SEP + '\n' + body + '\nRun `pnpm wp-finish-push-dev --help` for the full command.\n';
    }
}
