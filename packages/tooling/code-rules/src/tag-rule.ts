/**
 * Shared "every modified project must carry a `<prefix>` nx tag" rule engine.
 *
 * Both `framework-tag` (prefix `framework:`) and `role-tag` (prefix `role:`) are
 * the same rule with different prefix/known-values/messages, so the
 * project-walking + diff-scoping + mode logic lives here once and each concrete
 * rule supplies only a {@link TagRuleSpec}.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectMode, detectBase, getChangedFiles, toError } from '@webpieces/rules-config';
import { ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

/** A project (identified by its project.json) missing the required tag. */
export class MissingTagProject {
    constructor(
        public readonly name: string,
        public readonly projectJsonPath: string
    ) {}
}

/** The knobs and messages that make a concrete tag rule out of the shared engine. */
export class TagRuleSpec {
    constructor(
        /** Tag prefix, e.g. `framework:` or `role:`. */
        public readonly tagPrefix: string,
        /** Rule id, e.g. `framework-tag` / `role-tag` (used in skip/validating logs). */
        public readonly ruleName: string,
        /** Human label for the "Validating X" banner, e.g. `Framework Tag`. */
        public readonly ruleLabel: string,
        /** Default allowed values when config.knownTypes is empty. */
        public readonly defaultKnownTypes: string[],
        /** Print the violation report for the missing-tag projects. */
        public readonly report: (untagged: MissingTagProject[], knownTypes: string[], mode: ProjectMode) => void
    ) {}
}

/** The config fields the shared engine reads (shared by every tag rule config). */
export interface TagRuleConfig {
    mode?: ProjectMode;
    knownTypes?: string[];
    ignoreModifiedUntilEpoch?: number;
    ignoreRuleWhileOnBranch?: string;
}

type RawProjectJson = { name?: string; tags?: string[] };

class ProjectJson {
    constructor(
        public readonly name: string | null,
        public readonly tags: string[]
    ) {}
}

/**
 * Parse `name` + `tags` from a project.json. Returns an empty ProjectJson when
 * unreadable/unparseable — config validation owns malformed-json reporting; this
 * rule just nudges for a tag and must never crash the build.
 */
function readProjectJson(projectJsonPath: string, workspaceRoot: string): ProjectJson {
    const fullPath = path.join(workspaceRoot, projectJsonPath);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const parsed: RawProjectJson = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
        const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((tag: string) => typeof tag === 'string') : [];
        return new ProjectJson(name, tags);
    } catch (err: unknown) {
        const error = toError(err);
        void error; // swallow — malformed project.json is not this rule's concern
        return new ProjectJson(null, []);
    }
}

/**
 * Walk up from a changed file to the nearest ancestor directory containing a
 * project.json (the file's owning nx project). Returns the repo-relative
 * project.json path, or null when the file belongs to no project.
 */
function findOwningProjectJson(changedFile: string, workspaceRoot: string): string | null {
    let dir = path.dirname(changedFile);
    while (true) {
        const candidate = path.join(dir, 'project.json');
        if (fs.existsSync(path.join(workspaceRoot, candidate))) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir || dir === '.' || dir === '') {
            return null;
        }
        dir = parent;
    }
}

function hasTag(tags: string[], tagPrefix: string): boolean {
    return tags.some((tag: string) => tag.startsWith(tagPrefix) && tag.slice(tagPrefix.length).trim().length > 0);
}

/** Every owning project of a changed file that is missing a `<tagPrefix>` tag. */
export function findProjectsMissingTag(
    workspaceRoot: string,
    changedFiles: string[],
    tagPrefix: string
): MissingTagProject[] {
    const projectJsonPaths = new Set<string>();
    for (const file of changedFiles) {
        const owning = findOwningProjectJson(file, workspaceRoot);
        if (owning !== null) {
            projectJsonPaths.add(owning);
        }
    }

    const missing: MissingTagProject[] = [];
    for (const projectJsonPath of Array.from(projectJsonPaths).sort()) {
        const projectJson = readProjectJson(projectJsonPath, workspaceRoot);
        if (!hasTag(projectJson.tags, tagPrefix)) {
            const name = projectJson.name ?? path.dirname(projectJsonPath);
            missing.push(new MissingTagProject(name, projectJsonPath));
        }
    }
    return missing;
}

function resolveMode(
    normalMode: ProjectMode,
    epoch: number | undefined,
    branchPattern: string | undefined,
    ruleName: string
): ProjectMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping ${ruleName} validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

/** Run a concrete tag rule (framework-tag / role-tag) against the git diff. */
export async function runTagValidator(
    options: TagRuleConfig,
    workspaceRoot: string,
    spec: TagRuleSpec
): Promise<ExecutorResult> {
    const mode: ProjectMode = resolveMode(
        options.mode ?? 'OFF',
        options.ignoreModifiedUntilEpoch,
        options.ignoreRuleWhileOnBranch,
        spec.ruleName
    );
    const knownTypes = options.knownTypes && options.knownTypes.length > 0 ? options.knownTypes : spec.defaultKnownTypes;

    if (mode === 'OFF') {
        console.log(`\n⏭️  Skipping ${spec.ruleName} validation (mode: OFF)`);
        console.log('');
        return { success: true };
    }

    console.log(`\n📏 Validating ${spec.ruleLabel}\n`);
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log(`\n⏭️  Skipping ${spec.ruleName} validation (could not detect base branch)`);
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    // Project-level rule: ANY changed file (not just .ts) makes its owning
    // project require a tag, so include non-code files too.
    const changedFiles = getChangedFiles(workspaceRoot, base, head, { tsOnly: false });
    if (changedFiles.length === 0) {
        console.log('✅ No changed files in any project');
        return { success: true };
    }

    const missing = findProjectsMissingTag(workspaceRoot, changedFiles, spec.tagPrefix);
    if (missing.length === 0) {
        console.log(`✅ Every modified project declares a ${spec.tagPrefix.replace(/:$/, '')} tag`);
        return { success: true };
    }

    spec.report(missing, knownTypes, mode);
    return { success: false };
}
