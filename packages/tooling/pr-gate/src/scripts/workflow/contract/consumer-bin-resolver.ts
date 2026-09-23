import * as fs from 'fs';
import * as path from 'path';
import { Option, RuleFailError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { GeneratorPackage } from './generator-package';
import { JsonObject } from './json-value';

/** What to resolve, and who is asking. Data-only, per CLAUDE.md. */
export class ConsumerBinRequest {
    constructor(
        /** The failing target's name, so a refusal says WHICH step could not find its generator. */
        readonly ruleName: string,
        readonly generator: GeneratorPackage,
        /**
         * The CONSUMER's directories, nearest first — the project root, then the workspace root. Lookup
         * walks up from each exactly as node does, and never from the caller's own install location.
         */
        readonly searchFrom: readonly string[],
    ) {}
}

/** One generator bin, resolved out of the consumer's `node_modules`. Data-only. */
export class ConsumerBin {
    constructor(
        readonly packageName: string,
        readonly version: string,
        /** The installed package.json this was read from. */
        readonly packageJson: string,
        /** Absolute path to the bin's entry script. */
        readonly binPath: string,
    ) {}
}

/** A parsed `X.Y.Z[-pre]`. A prerelease sorts BELOW its release, which is what semver says. */
class ReleaseVersion {
    constructor(
        readonly major: number,
        readonly minor: number,
        readonly patch: number,
        readonly prerelease: boolean,
    ) {}

    isAtLeast(other: ReleaseVersion): boolean {
        if (this.major !== other.major) return this.major > other.major;
        if (this.minor !== other.minor) return this.minor > other.minor;
        if (this.patch !== other.patch) return this.patch > other.patch;
        return !this.prerelease || other.prerelease;
    }
}

/**
 * Finds a generator bin in the CONSUMER's `node_modules`, never in a copy bundled beside the caller,
 * and refuses one too old to have the capabilities the caller needs.
 *
 * ## Why never a bundled copy
 *
 * The generator reads the decorators the consumer's contracts are written with, so it must be the
 * release the consumer pinned alongside those decorators. A copy shipped inside the nx plugin would be
 * the PLUGIN's release — the rules stream, which a repo deliberately runs one release behind — and would
 * document an app with a reader from a different release. The lookup therefore starts only from the
 * directories the caller names (the consumer's project and workspace), and walks up from each exactly
 * as node's resolution does. It never consults `require.resolve` from this file, which is the one
 * lookup that WOULD find a bundled copy.
 *
 * ## The version handshake
 *
 * A capability always ships in the generator (the server stream) BEFORE a caller relies on it, so an
 * installed generator older than `minimumVersion` is a pin to bump, never a bug to work around. The
 * refusal names the bump: `@webpieces/openapi-generator >= X.Y.Z`.
 */
@injectable(bindingScopeValues.Singleton)
export class ConsumerBinResolver {
    resolve(request: ConsumerBinRequest): ConsumerBin {
        const packageJson = this.findPackageJson(request);
        const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as JsonObject;
        const version = typeof manifest['version'] === 'string' ? manifest['version'] : '';
        this.assertNewEnough(request, packageJson, version);
        const binPath = this.binPathOf(request, packageJson, manifest);
        return new ConsumerBin(request.generator.packageName, version, packageJson, binPath);
    }

    private findPackageJson(request: ConsumerBinRequest): string {
        for (const start of request.searchFrom) {
            let dir = path.resolve(start);
            for (;;) {
                const candidate = path.join(dir, 'node_modules', ...request.generator.packageName.split('/'), 'package.json');
                if (fs.existsSync(candidate)) return candidate;
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
        }
        throw new RuleFailError(
            request.ruleName,
            `${request.generator.packageName} is not installed in this workspace (looked in node_modules at and above: ` +
                `${request.searchFrom.join(', ')}). The generator must be the consumer's OWN install — the ` +
                `release pinned beside the decorators it reads — and is never taken from a bundled copy.`,
            undefined,
            undefined,
            [new Option(`Add it as a devDependency: ${request.generator.packageName} >= ${request.generator.minimumVersion}`, true)],
        );
    }

    private assertNewEnough(request: ConsumerBinRequest, packageJson: string, version: string): void {
        const minimum = this.parseVersion(request.generator.minimumVersion);
        if (minimum === undefined) {
            // Our own constant, not the consumer's input — a malformed one is a webpieces bug.
            throw new Error(`minimumVersion '${request.generator.minimumVersion}' for ${request.generator.packageName} is not X.Y.Z`);
        }
        const installed = this.parseVersion(version);
        if (installed !== undefined && installed.isAtLeast(minimum)) return;
        throw new RuleFailError(
            request.ruleName,
            `${request.generator.packageName} ${version === '' ? '(no version)' : version} is installed at ${packageJson}, ` +
                `and ${request.ruleName} needs ${request.generator.packageName} >= ${request.generator.minimumVersion}.` +
                (installed !== undefined && installed.prerelease
                    ? ' A prerelease such as a workspace link\'s 0.0.0-dev is not a release and has no compiled bin.'
                    : ''),
            undefined,
            undefined,
            [new Option(`Bump the devDependency to ${request.generator.packageName} >= ${request.generator.minimumVersion}`, true)],
        );
    }

    /** `X.Y.Z[-pre]`, or `undefined` for anything else — which the handshake then refuses. */
    private parseVersion(text: string): ReleaseVersion | undefined {
        const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(text.trim());
        if (match === null) return undefined;
        return new ReleaseVersion(Number(match[1]), Number(match[2]), Number(match[3]), match[4] !== undefined);
    }

    private binPathOf(request: ConsumerBinRequest, packageJson: string, manifest: JsonObject): string {
        const bin = manifest['bin'];
        const declared = typeof bin === 'string'
            ? bin
            : (bin !== null && typeof bin === 'object' && !Array.isArray(bin) ? (bin as JsonObject)[request.generator.binName] : undefined);
        const binPath = typeof declared === 'string' ? path.resolve(path.dirname(packageJson), declared) : '';
        if (binPath !== '' && fs.existsSync(binPath)) return binPath;
        throw new RuleFailError(
            request.ruleName,
            `${request.generator.packageName} at ${packageJson} declares no runnable '${request.generator.binName}' bin` +
                (binPath === '' ? '.' : ` (${binPath} does not exist).`),
            undefined,
            undefined,
            [new Option(`Reinstall a published release: ${request.generator.packageName} >= ${request.generator.minimumVersion}`, true)],
        );
    }
}
