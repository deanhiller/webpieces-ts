import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { WpOpenApiMain } from '../cli/WpOpenApiMain';

/**
 * Issue #1286: a declaration with MORE THAN ONE JSDoc block stacked above it is REFUSED, never
 * published with one of the blocks picked. Both repro shapes from the issue are fixtures written as
 * ordinary TypeScript and read through the real extractor:
 *
 * - `StackedHeaderApi.ts` — a FILE HEADER written as `/**` directly above an enum's own doc;
 * - `StrandedDocApi.ts` — a doc a refactor STRANDED on top of another declaration's own, on an enum,
 *   a property and a contract method at once, so the refusal is shown to name EVERY offender.
 *
 * `SectionHeaderApi.ts` is the cure for the first shape — the header as a plain block comment — and
 * must generate.
 */
class Harness {
    readonly fixtures = path.join(__dirname, 'fixtures');

    temporaryDirectory(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-stacked-'));
    }

    run(manifest: string): Map<string, string> {
        const result = new OpenApiCli().run(
            ['--manifest', path.join(this.fixtures, manifest), '--out', this.temporaryDirectory()],
            this.fixtures,
        );
        const written = new Map<string, string>();
        for (const file of result.written) {
            written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
        return written;
    }

    /** The failure a run threw, or undefined when it did not throw. The catch IS the assertion. */
    failureOf(manifest: string): OpenApiGenerationError | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this method returns
        try {
            this.run(manifest);
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            return err instanceof OpenApiGenerationError ? err : undefined;
        }
    }
}

const harness = new Harness();

/** A `process.stdout` stand-in, so the bin's own output is asserted rather than printed. */
class Sink {
    readonly lines: string[] = [];

    asStream(): NodeJS.WriteStream {
        const sink = this;
        return {
            write: (text: string): boolean => {
                sink.lines.push(text);
                return true;
            },
        } as NodeJS.WriteStream;
    }

    text(): string {
        return this.lines.join('');
    }
}

describe('stacked JSDoc (#1286)', () => {
    it('REFUSES a file header written as /** above a declaration, naming its file:line', () => {
        const failure = harness.failureOf('stacked-header.manifest.json');
        expect(failure, 'a stacked JSDoc block was published').toBeDefined();
        expect(failure!.message).toMatch(/1 declaration\(s\) have more than one JSDoc block/);
        expect(failure!.pointers).toEqual([
            `${path.join(harness.fixtures, 'StackedHeaderApi.ts')}:24:1 PromotionStateDto — ` +
                '2 JSDoc blocks, starting on lines 16, 21',
        ]);
    });

    it('REFUSES a stranded doc and names EVERY offender — enum, property and method — in one run', () => {
        const failure = harness.failureOf('stranded-doc.manifest.json');
        expect(failure, 'a stacked JSDoc block was published').toBeDefined();
        expect(failure!.message).toMatch(/3 declaration\(s\) have more than one JSDoc block/);
        const file = path.join(harness.fixtures, 'StrandedDocApi.ts');
        expect([...failure!.pointers].sort()).toEqual(
            [
                `${file}:18:1 MenuPublicationStatusDto — 2 JSDoc blocks, starting on lines 16, 17`,
                `${file}:26:5 MenuPublicationDto.id — 2 JSDoc blocks, starting on lines 24, 25`,
                `${file}:48:5 StrandedDocApi.get — 2 JSDoc blocks, starting on lines 42, 43`,
            ].sort(),
        );
    });

    it('prints BOTH fixes through the bin, exits non-zero, and writes nothing', () => {
        const sink = new Sink();
        const out = harness.temporaryDirectory();
        const code = new WpOpenApiMain().run(
            ['--manifest', path.join(harness.fixtures, 'stranded-doc.manifest.json'), '--out', out],
            harness.fixtures,
            sink.asStream(),
        );
        expect(code).toBe(1);
        const text = sink.text();
        expect(text).toContain('wp-openapi refused: 3 declaration(s) have more than one JSDoc block');
        expect(text).toContain('StrandedDocApi.ts:18:1 MenuPublicationStatusDto');
        expect(text).toContain(
            'A section or file header must be a /* */ comment, never /** */',
        );
        expect(text).toContain(
            'a doc stranded above another declaration must move back onto its own declaration',
        );
        expect(fs.readdirSync(out)).toEqual([]);
    });

    it('GENERATES when a /* */ section header sits above a single /** */ doc', () => {
        const written = harness.run('section-header.manifest.json');
        const document = JSON.parse(written.get('public-openapi.json')!) as {
            components: { schemas: Record<string, { description?: string }> };
        };
        expect(document.components.schemas['CouponStateDto'].description).toBe(
            'Every state a coupon can be in.',
        );
    });
});
