/**
 * Service Name Resolver
 *
 * Resolves the `serviceName` field written per project into
 * architecture/dependencies.json — the name a CLIENT uses to address this app at
 * runtime (`new ClientConfig('helper-fsdb')`), i.e. its deployed Cloud Run
 * service name, NOT its nx project name.
 *
 * It is DECLARED, never derived. The three naming spaces have no mechanical
 * relationship, and any strip-the-suffix rule gets it wrong somewhere:
 *
 *   nx project      | serviceName    | Cloud Run
 *   helper-svr      | helper-portal  | helper-portal
 *   helper-fsdb-svr | helper-fsdb    | helper-fsdb
 *   lang-server     | lang           | lang
 *
 * Declared in the project's own project.json, next to the code it names:
 *
 *   { "metadata": { "webpieces": { "serviceName": "helper-fsdb" } } }
 *
 * Absent is legal and common — a library or a browser app is never addressed by
 * name. A node WITHOUT one simply cannot be the resolved target of a targeted
 * client call, and the runtime graph says so out loud rather than guessing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectInfo } from './project-info';
import { toError } from '../toError';

/** The project.json key path holding the declared name: metadata.webpieces.serviceName. */
export const SERVICE_NAME_METADATA_PATH = 'metadata.webpieces.serviceName';

export class ServiceNameResolution {
    constructor(
        /** Declared service name, or null when none is declared (or resolution failed). */
        public readonly serviceName: string | null,
        /** Problem description when the declaration is present but unusable, otherwise null. */
        public readonly problem: string | null,
    ) {}
}

/**
 * Read `metadata.webpieces.serviceName` from the project's project.json. A missing file, a missing
 * key, or an unparseable file all resolve to "not declared" — only a PRESENT-but-wrong value (empty
 * or not a string) is a problem, because that is a typo the author wants told about.
 */
// webpieces-disable no-function-outside-class -- pure resolver, mirrors resolveRole/resolveDrawOnGraph
export function resolveServiceName(info: ProjectInfo, workspaceRoot: string): ServiceNameResolution {
    const raw = readServiceNameField(path.join(workspaceRoot, info.root, 'project.json'));
    if (raw === undefined) return new ServiceNameResolution(null, null);
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return new ServiceNameResolution(
            null,
            `${info.name}: ${SERVICE_NAME_METADATA_PATH} in project.json must be a non-empty string`,
        );
    }
    return new ServiceNameResolution(raw.trim(), null);
}

/**
 * Two projects claiming the same service name make every targeted client edge ambiguous, so the
 * graph would have to guess. Reported as a metadata problem instead. Appends to `problems`.
 */
// webpieces-disable no-function-outside-class -- pure validator, mirrors validateRoleDependencies
export function validateUniqueServiceNames(names: Map<string, string>, problems: string[]): void {
    const projectsByName = new Map<string, string[]>();
    for (const project of [...names.keys()].sort()) {
        const serviceName = names.get(project)!;
        const claimants = projectsByName.get(serviceName) ?? [];
        claimants.push(project);
        projectsByName.set(serviceName, claimants);
    }
    for (const serviceName of [...projectsByName.keys()].sort()) {
        const claimants = projectsByName.get(serviceName)!;
        if (claimants.length < 2) continue;
        problems.push(
            `serviceName '${serviceName}' is declared by ${claimants.length} projects ` +
                `(${claimants.join(', ')}) — a client naming it could not be routed to one of them. ` +
                `Give each project a distinct ${SERVICE_NAME_METADATA_PATH}.`,
        );
    }
}

/** The raw `metadata.webpieces.serviceName` value, or undefined when not present at all. */
// webpieces-disable no-any-unknown -- project.json is opaque consumer JSON until narrowed here
// webpieces-disable no-function-outside-class -- pure file accessor, matches the sibling resolvers
function readServiceNameField(projectJsonPath: string): unknown {
    if (!fs.existsSync(projectJsonPath)) return undefined;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const parsed = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
        return parsed?.metadata?.webpieces?.serviceName;
    } catch (err: unknown) {
        const error = toError(err);
        console.warn(`⚠️  Skipping unparseable ${projectJsonPath}: ${error.message}`);
        return undefined;
    }
}
