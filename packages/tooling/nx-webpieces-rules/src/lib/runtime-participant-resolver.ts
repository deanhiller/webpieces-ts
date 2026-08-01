/**
 * Runtime Participant Resolver
 *
 * Determines the `webpiecesRuntime` field written per project into
 * architecture/dependencies.json: WHICH @webpieces runtime packages this project's own
 * package.json declares.
 *
 * The runtime graph is built entirely out of webpieces contracts — routes registered through
 * http-routing, clients built through http-client-*, tasks enqueued through cloudtasks-client. A
 * process that declares NONE of those cannot appear on it as anything but a disconnected box: it
 * has no edges by construction and never will. Drawing it says "here is a service in this runtime"
 * about a service that is not in this runtime.
 *
 * DELIBERATELY NOT MARKERS: core-context, core-util, core-mock, winston, gcp-identity. Those are
 * utility/logging/auth-token packages that say nothing about whether a process speaks the webpieces
 * runtime — a NestJS service can and does use them. Two real ones prove it: orders-manager and
 * webhook-proxy-handler are pure NestJS/typeorm services that declare @webpieces/core-context, and
 * both must stay off the runtime drawing. Adding core-context here would silently draw them again.
 *
 * This resolver reports a project's OWN declarations only. Whether a NODE participates is decided
 * in runtime-graph.ts, which ORs this over the node's library closure — a service can legitimately
 * get its whole webpieces stack from a shared bootstrap library and declare nothing itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectInfo } from './project-info';
import { toError } from '../toError';

/**
 * Declaring one of these means the process speaks the webpieces runtime.
 *
 * Every entry is an actual runtime seam — serving HTTP (http-routing/http-server), calling it
 * (http-client-node/http-client-browser), or queueing work (cloudtasks-client). Nothing here is a
 * utility package; see the file header for why that distinction is the whole point.
 */
export const WEBPIECES_RUNTIME_MARKERS: ReadonlyArray<string> = [
    '@webpieces/cloudtasks-client',
    '@webpieces/http-client-browser',
    '@webpieces/http-client-node',
    '@webpieces/http-routing',
    '@webpieces/http-server',
];

export class RuntimeParticipantResolution {
    constructor(
        /**
         * Marker packages this project's OWN package.json declares, sorted. An empty array means it
         * declares none. `null` means there was no package.json to read at all — UNKNOWN, which is
         * never the same as "declares none" and must not be recorded as a negative.
         */
        public readonly markers: string[] | null,
        /** Problem description when resolution failed, otherwise null. */
        public readonly problem: string | null,
    ) {}
}

// webpieces-disable no-function-outside-class -- module-scope resolver, matching its siblings framework-resolver / role-resolver / draw-on-graph-resolver
export function resolveRuntimeParticipant(
    info: ProjectInfo,
    workspaceRoot: string,
): RuntimeParticipantResolution {
    const pkgJsonPath = path.join(workspaceRoot, info.root, 'package.json');
    // A project without a package.json is legitimate (a plain nx project.json library), so this is
    // UNKNOWN rather than a problem. Recording [] here would assert a negative we never checked.
    if (!fs.existsSync(pkgJsonPath)) return new RuntimeParticipantResolution(null, null);

    let allDeps: Record<string, string>;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        allDeps = {
            ...(pkgJson.dependencies ?? {}),
            ...(pkgJson.devDependencies ?? {}),
            ...(pkgJson.peerDependencies ?? {}),
        };
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(
            `Failed to parse ${pkgJsonPath} while resolving webpieces runtime packages for ${info.name}`,
            { cause: error },
        );
    }

    const markers = WEBPIECES_RUNTIME_MARKERS.filter((marker: string) => marker in allDeps);
    return new RuntimeParticipantResolution([...markers], null);
}

/**
 * Announce the role:server projects left off the runtime DRAWING for speaking no webpieces runtime
 * package. Shared by generate and validate so a local run and a CI log tell the same story.
 *
 * console.log, never a warning and never a problem: this is intended behavior, and a ⚠️ on every
 * clean run is exactly how a warning stream stops being read. But it is never SILENT either — the
 * omission is the thing #542 was written about, so it always says which projects and why.
 */
// webpieces-disable no-function-outside-class -- executor console reporter, kept beside the marker list it names
export function printAutoHiddenServers(autoHidden: string[]): void {
    if (autoHidden.length === 0) return;
    console.log(
        `🙈 ${autoHidden.length} role:server project(s) omitted from the runtime DRAWING ` +
            `(still present in runtime-dependencies.json):`,
    );
    for (const name of autoHidden) console.log(`     • ${name}`);
    console.log(
        `   Reason: none declares a webpieces runtime package (${WEBPIECES_RUNTIME_MARKERS.join(', ')}) ` +
            `in its package.json or in any workspace library it depends on, and none implements or ` +
            `calls an in-repo API contract — so it can only ever draw as a disconnected box.`,
    );
}
