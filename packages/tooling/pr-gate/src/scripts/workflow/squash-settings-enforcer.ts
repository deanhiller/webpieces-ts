import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';

/** The only correct value for `squash_merge_commit_title`: the PR title becomes the commit subject. */
export const SQUASH_TITLE_REQUIRED = 'PR_TITLE';
/** The only correct value for `squash_merge_commit_message`: the PR description becomes the commit body. */
export const SQUASH_MESSAGE_REQUIRED = 'PR_BODY';

/**
 * What GitHub currently says about how this repo composes a squash commit. All '' / false when `gh` could
 * not be asked — an unreadable answer must never be treated as a diagnosis. Data-only, per CLAUDE.md.
 */
export class SquashSettings {
    title = '';
    message = '';
    /** Whether THIS token can PATCH the repo. Without it the enforcer can only report. */
    admin = false;

    correct(): boolean {
        return this.title === SQUASH_TITLE_REQUIRED && this.message === SQUASH_MESSAGE_REQUIRED;
    }

    readable(): boolean {
        return this.title !== '' && this.message !== '';
    }

    describe(): string {
        return `squash_merge_commit_title=${this.title}, squash_merge_commit_message=${this.message}`;
    }
}

/**
 * Keeps the two GitHub repo settings that decide what a squash commit SAYS pinned to the only pair that
 * works — `PR_TITLE` + `PR_BODY` — repairing them in place when it can.
 *
 * ─── Why the tooling owns this and not a doc ───────────────────────────────────────────────────────
 * `wp-finish-upsert-pr` renders the PR description AS the commit body (see Dashboard.renderPrBody). That
 * design only pays off if GitHub actually copies the description into the squash commit, which is exactly
 * what `squash_merge_commit_message: PR_BODY` does — and on `COMMIT_MESSAGES` the branch's raw internal
 * commit messages land instead, while `BLANK` lands nothing at all.
 *
 * These are SERVER-SIDE settings. They are not in `webpieces.config.json`, not in the repo, not on disk
 * anywhere — so no amount of config removal can fix them and no validator can see them. That is precisely
 * why they were being handed to humans as a two-line instruction in CLAUDE.md, and an instruction in a
 * doc is the thing this repo's whole philosophy says will not be followed: it is invisible at the moment
 * anyone decides anything. The framework's OWN repo proved it by sitting on `COMMIT_MESSAGES` while both
 * consumer repos were already correct.
 *
 * There is exactly ONE right answer here, so there is nothing to configure — hence no config key, and no
 * opt-out. A repo that deliberately wanted `COMMIT_MESSAGES` would be a repo that does not want the gated
 * body in its history, and such a repo should stop rendering one rather than keep the setting.
 *
 * ─── Why it is safe to PATCH ───────────────────────────────────────────────────────────────────────
 * It changes only how GitHub PRE-FILLS a squash commit message. It cannot merge anything, cannot alter
 * history, cannot touch branch protection or permissions, and is reversible from the repo's Settings page
 * in two clicks. Every repair is printed, never silent. Without admin it degrades to a warning carrying
 * the exact `gh api` command, because a contributor without admin must not be blocked by a setting only an
 * owner can change.
 *
 * NEVER FATAL. The caller reaches this after the PR is already up; a `gh` failure here costs a good commit
 * message on a UI merge, which is not worth failing a finished run over.
 */
@injectable(bindingScopeValues.Singleton)
export class SquashSettingsEnforcer {
    /** Read → repair, or say precisely what is wrong and who can fix it. */
    ensure(): void {
        const current = this.read();
        if (!current.readable()) {
            process.stderr.write(
                '⚠️  Could not read this repo\'s squash-merge settings via gh, so could not verify that a\n' +
                `    UI merge would write the gated body. Check by hand: ${SQUASH_TITLE_REQUIRED} +\n` +
                `    ${SQUASH_MESSAGE_REQUIRED} under Settings → Pull Requests.\n`);
            return;
        }
        if (current.correct()) return; // The overwhelmingly common case: silent, and costs one API read.

        if (!current.admin) {
            process.stderr.write(this.noAdminMessage(current));
            return;
        }
        if (!this.patch()) {
            process.stderr.write(
                `⚠️  Could not update this repo's squash-merge settings (${current.describe()}).\n` +
                `    A UI merge will NOT write the gated body until it is fixed:\n${this.fixCommand()}`);
            return;
        }
        process.stdout.write(
            `   repaired this repo's squash-merge settings (was ${current.describe()}) →\n` +
            `   ${SQUASH_TITLE_REQUIRED} + ${SQUASH_MESSAGE_REQUIRED}, so a merge clicked in the GitHub UI\n` +
            '   now writes the same commit body this flow rendered ✓\n');
    }

    /**
     * The no-admin path. It states the CONSEQUENCE first and the remedy second, and it does not ask the
     * reader to go learn what these settings are — a contributor who cannot change them still needs to
     * know why main's history is about to look wrong, and who to send this to.
     */
    private noAdminMessage(current: SquashSettings): string {
        return (
            `⚠️  This repo composes squash commits as ${current.describe()}, so a merge clicked in the\n` +
            '    GitHub UI will NOT write the commit body this flow just rendered — the PR description is\n' +
            '    the gated body, and only PR_BODY copies it into main.\n' +
            '    Your token is not an admin on this repo, so this cannot be repaired automatically. Ask an\n' +
            '    owner to run:\n' + this.fixCommand() +
            '    (`pnpm wp-land-pr` writes the right body regardless, and is unaffected by this.)\n');
    }

    private fixCommand(): string {
        return (
            '      gh api -X PATCH repos/{owner}/{repo} \\\n' +
            `        -f squash_merge_commit_title=${SQUASH_TITLE_REQUIRED} \\\n` +
            `        -f squash_merge_commit_message=${SQUASH_MESSAGE_REQUIRED}\n`);
    }

    // Both settings AND whether we may change them, in ONE API call. Failure-tolerant: an all-'' result
    // reads as "unknown", never as "wrong", so a gh hiccup cannot trigger a spurious repair or warning.
    protected read(): SquashSettings {
        const result = spawnSync('gh', [
            'api', 'repos/{owner}/{repo}',
            '--jq', '"\\(.squash_merge_commit_title)\\t\\(.squash_merge_commit_message)\\t\\(.permissions.admin)"',
        ], { encoding: 'utf8' });
        const settings = new SquashSettings();
        if (result.status !== 0) return settings;
        const parts = (result.stdout ?? '').trim().split('\t');
        settings.title = parts[0] ?? '';
        settings.message = parts[1] ?? '';
        settings.admin = (parts[2] ?? '') === 'true';
        return settings;
    }

    protected patch(): boolean {
        const result = spawnSync('gh', [
            'api', '-X', 'PATCH', 'repos/{owner}/{repo}',
            '-f', `squash_merge_commit_title=${SQUASH_TITLE_REQUIRED}`,
            '-f', `squash_merge_commit_message=${SQUASH_MESSAGE_REQUIRED}`,
        ], { encoding: 'utf8' });
        return result.status === 0;
    }
}
