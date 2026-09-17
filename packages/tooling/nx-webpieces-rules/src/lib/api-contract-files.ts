/**
 * Per-API contract files: `architecture/apis/<ApiName>.json`.
 *
 * WHY these exist (issue #949): the full endpoint contract used to live inside
 * architecture/dependencies.json under `apiContracts`, so adding ONE `@Endpoint` rewrote the project
 * dependency graph and failed validate-architecture-unchanged until `architecture:generate` was rerun.
 * dependencies.json is meant to change only when PROJECT dependencies change. Each API's contract now
 * lives in its own generated file, and dependencies.json only LINKS to it (`apiContractFiles`), so it
 * changes when an API is added or removed — never when an endpoint is.
 *
 * These files are written by `architecture:generate` and deliberately NOT drift-gated: nothing
 * compares them to source. The runtime graph (generate, validate-runtime-architecture) reads its
 * queue/trigger data from them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RuleFailError, Option } from '@webpieces/rules-config';
import type { ApiContract, ApiContracts } from './api-usage/api-relations';
import { toError } from '../toError';

/** The directory, relative to dependencies.json's own directory, holding one file per API. */
export const API_CONTRACTS_DIR = 'apis';

/** The rule name every contract-file failure is reported under. */
export const API_CONTRACT_FILES_RULE = 'validate-architecture-unchanged';

/** apiClassName -> path of its contract file, RELATIVE to dependencies.json's directory. */
export type ApiContractFileRefs = Record<string, string>;

/**
 * What one `architecture:generate` pass did to the `apis/` directory, so the executor can say so.
 */
export class ApiContractFilesWriteResult {
    constructor(
        public readonly written: string[],
        public readonly deleted: string[],
    ) {}
}

/**
 * Reads and writes the per-API contract files. All paths are resolved against the directory that
 * holds dependencies.json (`graphPath`), so a non-default graphPath keeps its contracts beside it.
 */
export class ApiContractFiles {
    /** The link dependencies.json carries for one API: `apis/<ApiName>.json`. */
    refFor(api: string): string {
        return `${API_CONTRACTS_DIR}/${api}.json`;
    }

    /** The link table for every contract, in the contracts' (already sorted) order. */
    refsFor(contracts: ApiContracts): ApiContractFileRefs {
        const refs: ApiContractFileRefs = {};
        for (const api of Object.keys(contracts).sort()) refs[api] = this.refFor(api);
        return refs;
    }

    /**
     * Write one file per contract and DELETE every `apis/*.json` whose API no longer exists, so a
     * removed API never leaves a stale contract behind for the runtime graph to read.
     */
    write(workspaceRoot: string, graphPath: string, contracts: ApiContracts): ApiContractFilesWriteResult {
        const dir = this.dirFor(workspaceRoot, graphPath);
        const written: string[] = [];
        const apis = Object.keys(contracts).sort();
        if (apis.length > 0) fs.mkdirSync(dir, { recursive: true });
        for (const api of apis) {
            const fullPath = path.join(dir, `${api}.json`);
            fs.writeFileSync(fullPath, this.format(api, contracts[api]), 'utf-8');
            written.push(fullPath);
        }
        const deleted = this.deleteStale(dir, new Set(apis));
        return new ApiContractFilesWriteResult(written, deleted);
    }

    /**
     * Load every contract dependencies.json links to. A missing or unreadable file FAILS: the runtime
     * graph would otherwise silently lose that API's queues and triggers.
     */
    load(workspaceRoot: string, graphPath: string, refs: ApiContractFileRefs): ApiContracts {
        const baseDir = path.dirname(path.join(workspaceRoot, graphPath));
        const contracts: ApiContracts = {};
        for (const api of Object.keys(refs).sort()) {
            contracts[api] = this.loadOne(api, path.join(baseDir, refs[api]));
        }
        return contracts;
    }

    private loadOne(api: string, fullPath: string): ApiContract {
        if (!fs.existsSync(fullPath)) {
            throw new RuleFailError(
                API_CONTRACT_FILES_RULE,
                `dependencies.json links ${api} to ${fullPath}, but that file does not exist.`,
                undefined,
                undefined,
                [new Option('Regenerate the architecture files: pnpm nx run architecture:generate', true)],
            );
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as ApiContractFileJson;
            const contract: ApiContract = {
                owner: parsed.owner,
                apiKind: parsed.apiKind,
                basePath: parsed.basePath,
                methods: parsed.methods,
            };
            return contract;
        } catch (err: unknown) {
            const error = toError(err);
            throw new RuleFailError(
                API_CONTRACT_FILES_RULE,
                `Could not read the ${api} contract file ${fullPath}: ${error.message}`,
                undefined,
                undefined,
                [new Option('Regenerate the architecture files: pnpm nx run architecture:generate', true)],
                undefined,
                error,
            );
        }
    }

    /** Pretty, deterministic JSON: the api name first, then the contract in its declared field order. */
    private format(api: string, contract: ApiContract): string {
        const file: ApiContractFileJson = {
            api,
            owner: contract.owner,
            apiKind: contract.apiKind,
            basePath: contract.basePath,
            methods: contract.methods,
        };
        return JSON.stringify(file, null, 4) + '\n';
    }

    private dirFor(workspaceRoot: string, graphPath: string): string {
        return path.join(path.dirname(path.join(workspaceRoot, graphPath)), API_CONTRACTS_DIR);
    }

    private deleteStale(dir: string, keep: Set<string>): string[] {
        if (!fs.existsSync(dir)) return [];
        const deleted: string[] = [];
        for (const name of fs.readdirSync(dir).sort()) {
            if (!name.endsWith('.json')) continue;
            if (keep.has(name.slice(0, -'.json'.length))) continue;
            const fullPath = path.join(dir, name);
            fs.rmSync(fullPath);
            deleted.push(fullPath);
        }
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        return deleted;
    }
}

/** The on-disk shape of one `apis/<ApiName>.json`. Describes foreign JSON we narrow on read. */
interface ApiContractFileJson extends ApiContract {
    api: string;
}
