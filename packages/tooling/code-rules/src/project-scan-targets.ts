/**
 * Which PROJECTS a project-scoped rule judges — the two tag-truth code rules (#1064),
 * `framework-tsconfig` and `framework-packages` — and the `framework:` tags each carries.
 *
 *   MODIFIED_PROJECTS — every project owning a changed file (any file, not only .ts: a project.json or
 *                       tsconfig edit is exactly what these rules judge)
 *   RUN_EVERY_TIME    — every project in the repo, every run (the migration sweep)
 *
 * The per-run `--projects` restriction of the debug run (#1027) narrows both.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiffScope } from "@webpieces/rules-config";
import { ProjectScanMode } from "./configs/tag-truth-configs";
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';
import { ProjectCatalog, ProjectEntry, ScanRestriction } from './scan-scope';

const FRAMEWORK_TAG_PREFIX = 'framework:';

/** The only field of a project.json this reads. */
type RawProjectTags = { tags?: string[] };

/** One project to judge and its framework env set. Data-only. */
export class ScannedProject {
    constructor(
        readonly name: string,
        /** Repo-relative, '/'-separated, no trailing slash. */
        readonly dir: string,
        /** The `framework:` tag values, in declaration order, de-duplicated. Empty when untagged. */
        readonly frameworks: readonly string[],
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class ProjectScanTargets {
    constructor(
        private readonly diffScope: DiffScope,
        private readonly catalog: ProjectCatalog,
        private readonly restriction: ScanRestriction,
    ) {}

    /** The projects `mode` judges, root project excluded. `mode` must not be OFF. */
    projects(workspaceRoot: string, mode: ProjectScanMode, ruleName: string): ScannedProject[] {
        const all = this.catalog.all(workspaceRoot).filter((p: ProjectEntry) => p.dir !== '');
        const chosen = mode === 'RUN_EVERY_TIME' ? all : this.touched(workspaceRoot, all, ruleName);
        const names = this.restriction.projectNames;
        const restricted = names === undefined ? chosen : chosen.filter((p: ProjectEntry) => names.includes(p.name));
        return restricted
            .map((p: ProjectEntry) => new ScannedProject(p.name, p.dir, this.frameworksOf(workspaceRoot, p.dir)))
            .sort((a: ScannedProject, b: ScannedProject) => a.dir.localeCompare(b.dir));
    }

    private touched(workspaceRoot: string, all: ProjectEntry[], ruleName: string): ProjectEntry[] {
        const range = this.diffScope.resolveBase(workspaceRoot);
        if (range.base === undefined) {
            throw new InformAiError(
                `${ruleName} could not determine the comparison base for MODIFIED_PROJECTS. Set NX_BASE to the ` +
                    'base branch or commit and retry.',
            );
        }
        const dirs = new Set<string>();
        for (const file of this.diffScope.getChangedFiles(workspaceRoot, range.base, range.head, { tsOnly: false })) {
            const owner = this.catalog.ownerOf(workspaceRoot, file);
            if (owner !== undefined) dirs.add(owner.dir);
        }
        return all.filter((p: ProjectEntry) => dirs.has(p.dir));
    }

    /** The `framework:` values of a project.json. Unreadable JSON is the plumbing error it is. */
    private frameworksOf(workspaceRoot: string, dir: string): string[] {
        const file = path.join(workspaceRoot, dir, 'project.json');
        // webpieces-disable no-unmanaged-exceptions -- add the exact project.json path while preserving the parse/read failure as cause
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RawProjectTags;
            const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
            const values = tags
                .filter((tag: string) => typeof tag === 'string' && tag.startsWith(FRAMEWORK_TAG_PREFIX))
                .map((tag: string) => tag.slice(FRAMEWORK_TAG_PREFIX.length).trim())
                .filter((value: string) => value.length > 0);
            return Array.from(new Set(values));
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`Cannot read framework tags from ${file} — fix project.json and retry.`, {
                cause: error,
            });
        }
    }
}
