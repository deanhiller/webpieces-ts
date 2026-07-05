/**
 * Validate Framework Tag Executor
 *
 * Every project that a changed source file belongs to must carry a
 * `framework:<value>` nx tag in its project.json. That tag is the project's
 * "libType" — which client side it targets:
 *
 *   framework:angular | framework:react | framework:express | framework:all
 *
 * ("all" = a library usable by any side.) It is the source of truth for the
 * `framework` field written into architecture/dependencies.json and for the
 * `library-types-match-client` rule, which uses it to keep an express project
 * from depending on an angular-only library (and vice-versa).
 *
 * ============================================================================
 * VIOLATION (BAD)
 * ============================================================================
 * A project.json with no `framework:` tag whose source was modified:
 *   { "name": "my-lib", "tags": [] }
 *
 * ============================================================================
 * ALLOWED
 * ============================================================================
 *   { "name": "my-lib", "tags": ["framework:all"] }
 *
 * ============================================================================
 * MODES (PROJECT-BASED)
 * ============================================================================
 * - OFF:                     Skip validation entirely
 * - NEW_AND_MODIFIED_CODE
 *   / NEW_AND_MODIFIED_FILES: Require a framework tag on every project that owns
 *                            a changed .ts file (both modes behave the same here
 *                            — the check is project-level, not line-level).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModifiedCodeMode, FrameworkTagConfig, detectBase, getChangedFiles, toError } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

const FRAMEWORK_TAG_PREFIX = 'framework:';
const DEFAULT_KNOWN_TYPES = ['angular', 'react', 'express', 'all'];

/**
 * A project (identified by its project.json) that owns at least one changed
 * file but is missing a `framework:` tag.
 */
class UntaggedProject {
    constructor(
        public readonly name: string,
        public readonly projectJsonPath: string
    ) {}
}

/**
 * Raw shape parsed out of a project.json (only the fields this rule reads).
 */
type RawProjectJson = { name?: string; tags?: string[] };

/**
 * The parts of a project.json this rule reads.
 */
class ProjectJson {
    constructor(
        public readonly name: string | null,
        public readonly tags: string[]
    ) {}
}

/**
 * Parse the `name` + `tags` from a project.json. Returns an empty ProjectJson
 * (no name, no tags) when the file is unreadable/unparseable — config
 * validation owns malformed-json reporting; this rule just nudges for a tag and
 * must never crash the build.
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
 * project.json path, or null when the file belongs to no project (e.g. a
 * workspace-root config file).
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

function hasFrameworkTag(tags: string[]): boolean {
    return tags.some((tag: string) => tag.startsWith(FRAMEWORK_TAG_PREFIX) && tag.slice(FRAMEWORK_TAG_PREFIX.length).trim().length > 0);
}

export function findUntaggedProjects(workspaceRoot: string, changedFiles: string[]): UntaggedProject[] {
    const projectJsonPaths = new Set<string>();
    for (const file of changedFiles) {
        const owning = findOwningProjectJson(file, workspaceRoot);
        if (owning !== null) {
            projectJsonPaths.add(owning);
        }
    }

    const untagged: UntaggedProject[] = [];
    for (const projectJsonPath of Array.from(projectJsonPaths).sort()) {
        const projectJson = readProjectJson(projectJsonPath, workspaceRoot);
        if (!hasFrameworkTag(projectJson.tags)) {
            const name = projectJson.name ?? path.dirname(projectJsonPath);
            untagged.push(new UntaggedProject(name, projectJsonPath));
        }
    }
    return untagged;
}

function reportViolations(untagged: UntaggedProject[], knownTypes: string[], mode: ModifiedCodeMode): void {
    const suggestion = knownTypes.map((t: string) => `${FRAMEWORK_TAG_PREFIX}${t}`).join(' | ');
    console.error('');
    console.error('❌ Every modified project must declare which client side it targets (a framework tag)!');
    console.error('');
    console.error(`   Add ONE of these to the project's project.json "tags" array: ${suggestion}`);
    console.error('   ("all" = a library usable by any side — angular, react and express can all import it.)');
    console.error('   This libType drives architecture/dependencies.json and the library-types-match-client rule.');
    console.error('');

    for (const project of untagged) {
        console.error(`  ❌ ${project.name} — ${project.projectJsonPath}`);
        console.error(`     add e.g. "tags": ["${FRAMEWORK_TAG_PREFIX}all"]`);
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping framework-tag validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(options: FrameworkTagConfig, workspaceRoot: string): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const knownTypes = options.knownTypes && options.knownTypes.length > 0 ? options.knownTypes : DEFAULT_KNOWN_TYPES;

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping framework-tag validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating Framework Tag\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log('\n⏭️  Skipping framework-tag validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const changedFiles = getChangedFiles(workspaceRoot, base, head);
    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    const untagged = findUntaggedProjects(workspaceRoot, changedFiles);
    if (untagged.length === 0) {
        console.log('✅ Every modified project declares a framework tag');
        return { success: true };
    }

    reportViolations(untagged, knownTypes, mode);
    return { success: false };
}

export class FrameworkTagValidator extends CodeValidator<FrameworkTagConfig> {
    constructor(config: FrameworkTagConfig) {
        super(config, 'framework-tag');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
