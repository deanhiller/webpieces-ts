import * as fs from 'fs';
import * as path from 'path';
import {
    RecordedEndpoint,
    RecordedTestCase,
    RecordSerializer,
    TestCaseRecorder,
} from '@webpieces/core-util';
import { toError } from '@webpieces/core-util';
import { SpecGenerator } from './SpecGenerator';
import { LogManager } from '@webpieces/core-util';

/**
 * TestCaseRecorderImpl - Server-side recorder (port of Java
 * TestCaseRecorderImpl, minus the fragile bean-reflection codegen).
 *
 * One instance per recorded request (created by RecordingFilter and placed in
 * the RequestContext under RecorderKeys.RECORDER). Downstream hooks - the
 * http-client proxy and recordable() wrappers - add every call they make.
 *
 * spitOutTestCase() emits:
 * - a diffable JSON FIXTURE (the stable artifact: request, ctx snapshot,
 *   response, all downstream calls) - also perfect input for an AI to write
 *   a richer spec from
 * - a small deterministic .spec.ts from SpecGenerator
 * Both are always logged; written to recordingDir when configured.
 * NEVER breaks production - the whole body is caught and logged.
 */
const log = LogManager.getLogger('TestCaseRecorder');

export class TestCaseRecorderImpl implements TestCaseRecorder {
    private downstreamCalls: RecordedEndpoint[] = [];
    private serializer = new RecordSerializer();
    private specGenerator = new SpecGenerator();

    addEndpointInfo(info: RecordedEndpoint): void {
        this.downstreamCalls.push(info);
    }

    getLastEndpointInfo(): RecordedEndpoint | undefined {
        return this.downstreamCalls[this.downstreamCalls.length - 1];
    }

    /**
     * Emit the recorded test case. Called by RecordingFilter in its finally.
     *
     * @param serverEndpoint - The inbound endpoint capture (request + response)
     * @param recordingDir - Directory to write fixture + spec files (optional)
     * @returns The built RecordedTestCase, or undefined if emission failed
     */
    spitOutTestCase(serverEndpoint: RecordedEndpoint, recordingDir?: string): RecordedTestCase | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- recording must NEVER break production requests
        try {
            const testCase = new RecordedTestCase(serverEndpoint, this.downstreamCalls, new Date().toISOString());
            const fixtureJson = this.serializer.serialize(testCase);

            const baseName = this.buildBaseName(serverEndpoint, testCase.recordedAt);
            const specSource = this.specGenerator.generate(testCase, `${baseName}.fixture.json`);

            log.info(`[TestCaseRecorder] Recorded ${serverEndpoint.apiName}.${serverEndpoint.methodName} ` +
                `(${this.downstreamCalls.length} downstream calls)\n` +
                `--- fixture (${baseName}.fixture.json) ---\n${fixtureJson}\n` +
                `--- generated spec (${baseName}.spec.ts) ---\n${specSource}`);

            if (recordingDir) {
                fs.mkdirSync(recordingDir, { recursive: true });
                fs.writeFileSync(path.join(recordingDir, `${baseName}.fixture.json`), fixtureJson);
                fs.writeFileSync(path.join(recordingDir, `${baseName}.spec.ts`), specSource);
                log.info(`[TestCaseRecorder] Wrote fixture + spec to ${recordingDir}/${baseName}.*`);
            }

            return testCase;
        } catch (err: unknown) {
            const error = toError(err);
            log.error('[TestCaseRecorder] Failed to emit test case (request unaffected)', error);
            return undefined;
        }
    }

    private buildBaseName(serverEndpoint: RecordedEndpoint, recordedAt: string): string {
        // 2026-07-04T10:22:33.123Z -> 2026-07-04T10-22-33 (filesystem-safe)
        const stamp = recordedAt.replace(/:/g, '-').replace(/\..*$/, '');
        return `${serverEndpoint.apiName}.${serverEndpoint.methodName}.${stamp}`;
    }
}
