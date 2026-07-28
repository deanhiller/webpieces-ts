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

/** The project.json key path holding a client's declared target: metadata.webpieces.callsService. */
export const CALLS_SERVICE_METADATA_PATH = 'metadata.webpieces.callsService';

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
    const raw = readWebpiecesField(path.join(workspaceRoot, info.root, 'project.json'), 'serviceName');
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
 * A client's declared target — the service it addresses when the call site cannot carry a literal
 * `ClientConfig` (the client is built in a SHARED library from a config field, so the literal lives
 * in the app, not the lib, one indirection away). Symmetric to `serviceName`: the IMPLEMENTING side
 * declares the name it answers to, the CALLING side declares the name it calls.
 *
 * Two shapes:
 *  - a single string — every untargeted `uses` in this project aims at that one service (the common
 *    case: most clients talk to exactly one server);
 *  - an `{ apiClassName: serviceName }` map — the mixed case, a client that genuinely calls several.
 */
export class CallsServiceResolution {
    constructor(
        /** Declared target(s), or null when none is declared (or resolution failed). */
        public readonly callsService: string | Record<string, string> | null,
        /** Problem description when the declaration is present but unusable, otherwise null. */
        public readonly problem: string | null,
    ) {}
}

/**
 * Read `metadata.webpieces.callsService` from the project's project.json. A missing file, a missing
 * key, or an unparseable file all resolve to "not declared". A PRESENT value must be either a
 * non-empty string or a non-empty object of non-empty string values — anything else is a typo the
 * author wants told about.
 */
// webpieces-disable no-function-outside-class -- pure resolver, mirrors resolveServiceName
export function resolveCallsService(info: ProjectInfo, workspaceRoot: string): CallsServiceResolution {
    const raw = readWebpiecesField(path.join(workspaceRoot, info.root, 'project.json'), 'callsService');
    if (raw === undefined) return new CallsServiceResolution(null, null);

    if (typeof raw === 'string') {
        if (raw.trim().length === 0) {
            return new CallsServiceResolution(
                null,
                `${info.name}: ${CALLS_SERVICE_METADATA_PATH} in project.json must be a non-empty string`,
            );
        }
        return new CallsServiceResolution(raw.trim(), null);
    }

    if (isPlainRecord(raw)) {
        const apis = Object.keys(raw);
        if (apis.length === 0) {
            return new CallsServiceResolution(
                null,
                `${info.name}: ${CALLS_SERVICE_METADATA_PATH} map in project.json must have at least one entry`,
            );
        }
        const map: Record<string, string> = {};
        for (const api of apis) {
            const target = raw[api];
            if (typeof target !== 'string' || target.trim().length === 0) {
                return new CallsServiceResolution(
                    null,
                    `${info.name}: ${CALLS_SERVICE_METADATA_PATH}['${api}'] in project.json must be a ` +
                        `non-empty string (an api-class -> serviceName map)`,
                );
            }
            map[api] = target.trim();
        }
        return new CallsServiceResolution(map, null);
    }

    return new CallsServiceResolution(
        null,
        `${info.name}: ${CALLS_SERVICE_METADATA_PATH} in project.json must be a non-empty string, or an ` +
            `{ apiClassName: serviceName } map for a client that calls several services`,
    );
}

/** True when a value is a plain object (a map), not an array or null. */
// webpieces-disable no-any-unknown -- narrowing opaque project.json JSON
// webpieces-disable no-function-outside-class -- pure type guard for the resolver above
function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** The raw `metadata.webpieces.<field>` value, or undefined when not present at all. */
// webpieces-disable no-any-unknown -- project.json is opaque consumer JSON until narrowed here
// webpieces-disable no-function-outside-class -- pure file accessor, matches the sibling resolvers
function readWebpiecesField(projectJsonPath: string, field: string): unknown {
    if (!fs.existsSync(projectJsonPath)) return undefined;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const parsed = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
        return parsed?.metadata?.webpieces?.[field];
    } catch (err: unknown) {
        const error = toError(err);
        console.warn(`⚠️  Skipping unparseable ${projectJsonPath}: ${error.message}`);
        return undefined;
    }
}
