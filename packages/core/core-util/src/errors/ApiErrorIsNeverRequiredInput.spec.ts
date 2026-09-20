import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `ApiError` MUST NOT be a REQUIRED INPUT TYPE in framework code (#961).
 *
 * `Error` is the parent of everything. `ApiError` is a CONVENIENCE taxonomy webpieces ships so the
 * common cases are easy — it is not a thing the framework may demand from an application. An app may
 * perfectly well define `MyLibError extends Error` and subclass only that, and it must be able to
 * hand that to every webpieces seam. Requiring `ApiError` forces the app to adopt our taxonomy in
 * order to use our API.
 *
 * PRODUCING our own typed errors is fine and stays — this is about what we ACCEPT.
 *
 * The allowlist below is the mapper layer, where the taxonomy is the whole point: the errors
 * themselves, their codec, their HTTP status table, the default failure classifier and the received-error rule. Everything
 * else takes `Error`. A new entry here needs the same justification those five have.
 */
const ALLOWED = [
    'packages/core/core-util/src/errors/ApiError.ts',
    'packages/core/core-util/src/errors/ApiErrorCodec.ts',
    'packages/core/core-util/src/http/ApiErrorHttpStatus.ts',
    'packages/core/core-util/src/http/ApiErrorHttpStatusCompileAssertions.ts',
    'packages/core/core-util/src/http/WebpiecesDefaultFailureClassifier.ts',
    // The uniform rule for an error RECEIVED from a peer: it takes the DECODED peer error, which is
    // an ApiError by construction (ApiErrorCodec.decode produces one) and is never app input.
    'packages/core/core-util/src/errors/ReceivedApiErrorRule.ts',
];

/** `(error: ApiError`, `, error: ApiError,`, `error: ApiError)` — a PARAMETER typed ApiError. */
const PARAMETER = /(?<![A-Za-z])[A-Za-z_][A-Za-z0-9_]*\??:\s*ApiError\s*(?=[,)])/;

class ApiErrorInputScan {
    readonly offenders: string[] = [];

    scan(root: string): void {
        this.walk(join(root, 'packages'), root);
    }

    private walk(dir: string, root: string): void {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
                this.walk(full, root);
                continue;
            }
            if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
            const rel = relative(root, full).split(sep).join('/');
            if (ALLOWED.includes(rel)) continue;
            const lines = readFileSync(full, 'utf8').split('\n');
            lines.forEach((line: string, index: number) => {
                if (PARAMETER.test(line))
                    this.offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
            });
        }
    }
}

describe('ApiError is never a REQUIRED INPUT from app code', () => {
    it('no framework source outside the mapper layer takes an ApiError parameter', () => {
        const root = process.cwd();
        const scan = new ApiErrorInputScan();
        scan.scan(root);

        expect(scan.offenders).toEqual([]);
    });

    it('the detector actually fires, so the assertion above cannot rot into decoration', () => {
        expect(
            PARAMETER.test('    fail(error: ApiError, correlation?: string): Promise<void>;'),
        ).toBe(true);
        expect(PARAMETER.test('    static hasCode(error: ApiError): boolean {')).toBe(true);
        expect(PARAMETER.test('    fail(error: Error, correlation?: string): Promise<void>;')).toBe(
            false,
        );
        // PRODUCING one is not an input, and must not trip the detector.
        expect(PARAMETER.test('        throw new ApiBadRequestError(message);')).toBe(false);
        expect(PARAMETER.test('    static decode(value: unknown): ApiError {')).toBe(false);
    });
});
