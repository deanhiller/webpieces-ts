import * as path from 'node:path';
import { ArtifactWriter, GeneratedArtifact, OutputFormat } from '../emit/ArtifactWriter';
import { OpenApiGenerator } from '../generate/OpenApiGenerator';
import { InputsLoader } from '../load/InputsLoader';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

const MANIFEST = '--manifest';
const OUT = '--out';
const FORMAT = '--format';
const HELP = '--help';

const FLAGS = [MANIFEST, OUT, FORMAT];
const FORMATS: readonly string[] = ['json', 'yaml', 'both'];

export const USAGE = [
    'wp-openapi --manifest <openapi.manifest.json> --out <dir> [--format json|yaml|both]',
    '',
    'Renders the contracts a manifest names into OpenAPI 3.1.0. WHICH documents are written is a',
    "property of the contracts themselves — each one's @ApiType(...) names the documents it feeds:",
    '',
    '  full-private-openapi   every contract declaring SVC_TO_SVC, hidden methods included',
    '  public-openapi         contracts declaring EXTERNAL_CUSTOMER, minus every { hidden: true } method',
    '  mcp-openapi            contracts declaring MCP, carrying the x-mcp-* extensions',
    '',
    'A document no contract asked for is not written. --format chooses the serialization of',
    'whichever documents were written, and defaults to both.',
    '',
    'It exits non-zero, naming the JSON pointer of every offending field, rather than writing a',
    'document containing a field it has no schema for. There is no flag to switch that off.',
].join('\n');

/** The result of one run: what was written, so a caller can print it or assert on it. */
export class CliResult {
    constructor(
        readonly written: readonly string[],
        readonly artifacts: readonly GeneratedArtifact[],
    ) {}
}

/**
 * `wp-openapi`'s argument parsing and composition, with NO process-level concerns in it — no
 * `process.exit`, no `console` — so the whole command is exercised by the suite exactly as a user
 * runs it. The bin is the only thing that knows about the process.
 *
 * `--manifest` and `--out` are REQUIRED and have no defaults. A defaulted `--out` writes generated
 * documents somewhere the caller did not name, and a defaulted `--manifest` picks a service out of
 * whatever directory the command happened to start in.
 */
export class OpenApiCli {
    private readonly loader = new InputsLoader();
    private readonly generator = new OpenApiGenerator();
    private readonly writer = new ArtifactWriter();

    /** @param argv the arguments AFTER the program name. @param cwd what relative paths resolve against. */
    run(argv: readonly string[], cwd: string): CliResult {
        const manifest = this.valueOf(argv, MANIFEST);
        const out = this.valueOf(argv, OUT);
        if (manifest === undefined || out === undefined) {
            throw new OpenApiGenerationError(
                `wp-openapi needs both ${MANIFEST} and ${OUT}`,
                'wp-openapi',
                `Run: wp-openapi ${MANIFEST} <openapi.manifest.json> ${OUT} <dir>`,
            );
        }
        const inputs = this.loader.load(path.resolve(cwd, manifest));
        const documents = this.generator.generate(inputs);
        const artifacts = this.writer.artifacts(documents, this.formatOf(argv));
        return new CliResult(this.writer.write(path.resolve(cwd, out), artifacts), artifacts);
    }

    wantsHelp(argv: readonly string[]): boolean {
        return argv.includes(HELP);
    }

    /** `both` unless told otherwise: the second serialization comes free from the same document. */
    private formatOf(argv: readonly string[]): OutputFormat {
        const declared = this.valueOf(argv, FORMAT);
        if (declared === undefined) {
            return 'both';
        }
        if (!FORMATS.includes(declared)) {
            throw new OpenApiGenerationError(
                `unknown ${FORMAT} '${declared}'`,
                'wp-openapi',
                `${FORMAT} takes one of: ${FORMATS.join(', ')}.`,
            );
        }
        return declared as OutputFormat;
    }

    /**
     * The value after a flag. An UNKNOWN flag is refused rather than ignored: a mistyped `--manifets`
     * would otherwise fall through to "needs both flags", which sends the reader looking at the wrong
     * thing.
     */
    private valueOf(argv: readonly string[], flag: string): string | undefined {
        for (let i = 0; i < argv.length; i++) {
            const argument = argv[i]!;
            if (argument === flag) {
                return argv[i + 1];
            }
            if (argument.startsWith('--') && !FLAGS.includes(argument)) {
                throw new OpenApiGenerationError(
                    `unknown flag '${argument}'`,
                    'wp-openapi',
                    `wp-openapi takes ${FLAGS.join(', ')}, and nothing else.`,
                );
            }
        }
        return undefined;
    }
}
