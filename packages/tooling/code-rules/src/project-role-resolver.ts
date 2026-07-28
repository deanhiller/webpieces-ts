/**
 * Resolves the `role:` nx tag VALUE of the project owning a given source file.
 *
 * The role-tag rule ({@link ../tag-rule}) only checks a `role:` tag is PRESENT; a few rules
 * (e.g. no-client-creation-outside-server-or-client) additionally need the tag's VALUE to decide
 * whether a construct is allowed in that kind of project. This is the single home for that lookup:
 * walk up from the file to its nearest `project.json`, read its `tags`, and return the first
 * `role:<value>` value (or null when the file belongs to no project, or its project carries no role).
 *
 * Injectable so it composes into the code-rules DI DAG and can be shared by any validator.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const ROLE_TAG_PREFIX = 'role:';

/** The only field of a project.json this resolver reads. */
type RawProjectJson = { tags?: string[] };

@injectable(bindingScopeValues.Singleton)
export class ProjectRoleResolver {
    /** The `role:` value of the project owning `relFile`, or null when unknown/untagged. */
    roleOf(workspaceRoot: string, relFile: string): string | null {
        const projectJsonPath = this.findOwningProjectJson(workspaceRoot, relFile);
        if (projectJsonPath === null) return null;
        return this.readRole(path.join(workspaceRoot, projectJsonPath));
    }

    /** Nearest ancestor directory of `relFile` that holds a project.json (repo-relative), or null. */
    private findOwningProjectJson(workspaceRoot: string, relFile: string): string | null {
        let dir = path.dirname(relFile);
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

    /** First `role:<value>` tag value in a project.json, or null. Never throws — a malformed
     *  project.json is the role-tag rule's concern, not this resolver's. */
    private readRole(fullPath: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RawProjectJson;
            const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
            for (const tag of tags) {
                if (typeof tag !== 'string' || !tag.startsWith(ROLE_TAG_PREFIX)) continue;
                const value = tag.slice(ROLE_TAG_PREFIX.length).trim();
                if (value.length > 0) return value;
            }
            return null;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // swallow — malformed project.json is not this resolver's concern
            return null;
        }
    }
}
