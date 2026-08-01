/**
 * Which @webpieces runtime packages a project's OWN package.json declares — the per-project half of
 * "does this process even speak the webpieces runtime". The closure half lives in runtime-graph.ts
 * and is covered by runtime-graph-non-participant.spec.ts.
 *
 * The load-bearing spec here is the core-context one: two real NestJS services (orders-manager,
 * webhook-proxy-handler) declare @webpieces/core-context and must NOT count as participants.
 * Adding a utility package to the marker list would silently start drawing them again.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectInfo } from '../project-info';
import {
    resolveRuntimeParticipant,
    printAutoHiddenServers,
    WEBPIECES_RUNTIME_MARKERS,
} from '../runtime-participant-resolver';

let tmpRoot: string;

beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-participant-'));
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeProject(name: string, pkgJson: object | null): ProjectInfo {
    const root = path.join('projects', name);
    fs.mkdirSync(path.join(tmpRoot, root), { recursive: true });
    if (pkgJson !== null) {
        fs.writeFileSync(path.join(tmpRoot, root, 'package.json'), JSON.stringify(pkgJson), 'utf-8');
    }
    return new ProjectInfo(name, root, []);
}

describe('resolveRuntimeParticipant', () => {
    it('finds a marker in dependencies', () => {
        const info = writeProject('serves-http', {
            dependencies: { '@webpieces/http-routing': 'catalog:', express: '4.0.0' },
        });
        const resolution = resolveRuntimeParticipant(info, tmpRoot);
        expect(resolution.markers).toEqual(['@webpieces/http-routing']);
        expect(resolution.problem).toBeNull();
    });

    it('finds a marker in devDependencies and in peerDependencies', () => {
        const dev = writeProject('dev-marker', {
            devDependencies: { '@webpieces/http-client-node': 'catalog:' },
        });
        const peer = writeProject('peer-marker', {
            peerDependencies: { '@webpieces/cloudtasks-client': 'catalog:' },
        });
        expect(resolveRuntimeParticipant(dev, tmpRoot).markers).toEqual([
            '@webpieces/http-client-node',
        ]);
        expect(resolveRuntimeParticipant(peer, tmpRoot).markers).toEqual([
            '@webpieces/cloudtasks-client',
        ]);
    });

    it('returns every marker it declares, in the canonical (sorted) marker order', () => {
        const info = writeProject('full-stack', {
            dependencies: {
                '@webpieces/http-server': 'catalog:',
                '@webpieces/cloudtasks-client': 'catalog:',
                '@webpieces/http-routing': 'catalog:',
            },
        });
        expect(resolveRuntimeParticipant(info, tmpRoot).markers).toEqual([
            '@webpieces/cloudtasks-client',
            '@webpieces/http-routing',
            '@webpieces/http-server',
        ]);
    });

    it('does NOT count core-context / core-util — the orders-manager case', () => {
        const info = writeProject('nest-with-core-context', {
            dependencies: {
                '@webpieces/core-context': 'catalog:',
                '@webpieces/core-util': 'catalog:',
                '@nestjs/common': '10.0.0',
            },
        });
        expect(resolveRuntimeParticipant(info, tmpRoot).markers).toEqual([]);
    });

    it('does NOT count winston / gcp-identity either', () => {
        const info = writeProject('logs-and-auth', {
            dependencies: { '@webpieces/winston': 'catalog:', '@webpieces/gcp-identity': 'catalog:' },
        });
        expect(resolveRuntimeParticipant(info, tmpRoot).markers).toEqual([]);
    });

    it('returns [] for a plain NestJS/typeorm service', () => {
        const info = writeProject('legacy-nest', {
            dependencies: { '@nestjs/core': '10.0.0', typeorm: '0.3.0', express: '4.0.0' },
        });
        expect(resolveRuntimeParticipant(info, tmpRoot).markers).toEqual([]);
    });

    it('returns null — UNKNOWN, not "declares none" — when there is no package.json', () => {
        const info = writeProject('no-pkg-json', null);
        const resolution = resolveRuntimeParticipant(info, tmpRoot);
        expect(resolution.markers).toBeNull();
        expect(resolution.problem).toBeNull();
    });

    it('throws naming the file when package.json is malformed', () => {
        const info = writeProject('broken', null);
        fs.writeFileSync(path.join(tmpRoot, info.root, 'package.json'), '{ not json', 'utf-8');
        expect(() => resolveRuntimeParticipant(info, tmpRoot)).toThrow(/broken/);
    });
});

describe('printAutoHiddenServers', () => {
    it('prints nothing when nothing was hidden', () => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (msg: string): void => void lines.push(msg);
        printAutoHiddenServers([]);
        console.log = original;
        expect(lines).toEqual([]);
    });

    it('names every hidden project AND every marker package it would have needed', () => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (msg: string): void => void lines.push(msg);
        printAutoHiddenServers(['orders-manager', 'stores-manager']);
        console.log = original;
        const output = lines.join('\n');
        expect(output).toContain('orders-manager');
        expect(output).toContain('stores-manager');
        expect(output).toContain('still present in runtime-dependencies.json');
        for (const marker of WEBPIECES_RUNTIME_MARKERS) expect(output).toContain(marker);
    });
});
