import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { InformAiError } from '@webpieces/tooling-common';
import type { PackPolicyDeclaration } from './pack-policy-files';
import { RULE_LOCK_FILE, RULE_CATALOG_FILE } from './rule-pack-artifacts';

/** Git repositories must share policy through their index, including rules switched OFF. */
export class PolicyTracking {
    check(root: string, declarations: readonly PackPolicyDeclaration[]): void {
        // Standalone non-git schema validation is supported; CI and governed checkouts have .git.
        if (!fs.existsSync(path.join(root, '.git'))) return;
        const files = this.files(root, declarations);
        const ignored = spawnSync('git', ['check-ignore', '--no-index', '--', ...files], {
            cwd: root,
            encoding: 'utf8',
        });
        if (ignored.status !== 0 && ignored.status !== 1)
            throw new InformAiError(
                `Cannot verify policy ignore status: ${ignored.stderr}. Repair git access, then retry.`,
            );
        if (ignored.stdout.trim())
            throw new InformAiError(
                `Committed Webpieces policy is gitignored:\n${ignored.stdout}Remove the matching ignore patterns. Only .webpieces-logs/ belongs in .gitignore; .webpieces-config/ must be tracked.`,
            );
        const tracked = spawnSync(
            'git',
            ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', ...files],
            {
                cwd: root,
                encoding: 'utf8',
            },
        );
        if (tracked.status !== 0)
            throw new InformAiError(
                `Webpieces policy must be tracked by git: ${tracked.stderr}\nReview the policy files, then run pnpm wp-migrate-dirs --stage to stage the declaration, owner files, lock and catalog. Commit them with your change.`,
            );
    }

    stage(root: string, declarations: readonly PackPolicyDeclaration[]): void {
        const retired = spawnSync('git', ['ls-files', '-z', '--', '.webpieces'], {
            cwd: root,
            encoding: 'utf8',
        });
        if (retired.status !== 0)
            throw new InformAiError(
                `Cannot inspect retired policy paths for staging: ${retired.stderr}. Verify git access before retrying.`,
            );
        const deletions = retired.stdout.split('\0').filter((filename) => filename.length > 0);
        const result = spawnSync(
            'git',
            [
                '--literal-pathspecs',
                'add',
                '-A',
                '--',
                'webpieces.config.json',
                '.gitignore',
                ...this.files(root, declarations),
                ...deletions,
            ],
            { cwd: root, encoding: 'utf8' },
        );
        if (result.status !== 0)
            throw new InformAiError(
                `Could not stage Webpieces policy: ${result.stderr}. Remove policy ignore patterns and verify git access before retrying.`,
            );
    }

    private files(root: string, declarations: readonly PackPolicyDeclaration[]): string[] {
        const declared = [
            ...declarations.map((declaration) => declaration.config),
            RULE_LOCK_FILE,
            RULE_CATALOG_FILE,
        ];
        return [
            ...new Set(
                declared.flatMap((filename) => [
                    filename,
                    path.relative(
                        fs.realpathSync(root),
                        fs.realpathSync(path.join(root, filename)),
                    ),
                ]),
            ),
        ];
    }
}
