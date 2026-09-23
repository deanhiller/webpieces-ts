import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RuleFailError, renderRuleFailForHuman, specTempDirs, toError } from '@webpieces/rules-config';
import { ConsumerBinRequest, ConsumerBinResolver } from './consumer-bin-resolver';
import { OPENAPI_GENERATOR } from './generator-package';

/** Install a fake `@webpieces/openapi-generator` under `<root>/node_modules`. */
class FakeInstall {
    // webpieces-disable no-function-outside-class -- static test helper of this class
    static at(root: string, version: string, withBin = true): string {
        const dir = path.join(root, 'node_modules', '@webpieces', 'openapi-generator');
        fs.mkdirSync(path.join(dir, 'src', 'cli'), { recursive: true });
        const manifest = withBin
            ? { name: '@webpieces/openapi-generator', version, bin: { 'wp-openapi': 'src/cli/wp-openapi.js' } }
            : { name: '@webpieces/openapi-generator', version };
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(dir, 'src', 'cli', 'wp-openapi.js'), '');
        return dir;
    }
}

const resolver = new ConsumerBinResolver();

/** The refusal exactly as the top-level handler renders it — message AND cures. */
function refusal(searchFrom: string[]): string {
    const request = new ConsumerBinRequest('openapi-generate', OPENAPI_GENERATOR, searchFrom);
    // webpieces-disable no-unmanaged-exceptions -- the thrown RuleFailError IS the assertion subject here
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        resolver.resolve(request);
    } catch (err: unknown) {
        const error = toError(err);
        expect(error).toBeInstanceOf(RuleFailError);
        return renderRuleFailForHuman(error as RuleFailError);
    }
    throw new Error('expected a refusal');
}

describe('ConsumerBinResolver', () => {
    it("resolves the CONSUMER's install by walking up from the project, the way node does", () => {
        const workspace = specTempDirs.make('wp-consumer-bin-');
        FakeInstall.at(workspace, '0.4.813');
        const project = path.join(workspace, 'libraries', 'apis', 'partner-api');
        fs.mkdirSync(project, { recursive: true });

        const bin = resolver.resolve(new ConsumerBinRequest('openapi-generate', OPENAPI_GENERATOR, [project, workspace]));

        expect(bin.version).toBe('0.4.813');
        expect(bin.binPath).toBe(path.join(workspace, 'node_modules', '@webpieces', 'openapi-generator', 'src', 'cli', 'wp-openapi.js'));
    });

    it('NEVER takes a copy that is not under the consumer — a bundled copy beside the plugin is invisible', () => {
        const plugin = specTempDirs.make('wp-consumer-bin-plugin-');
        FakeInstall.at(plugin, '9.9.9');
        const consumer = specTempDirs.make('wp-consumer-bin-consumer-');

        const message = refusal([consumer]);

        expect(message).toContain('@webpieces/openapi-generator is not installed');
        expect(message).toContain('never taken from a bundled copy');
        expect(message).toContain('Fix Option 1: (preferred) Add it as a devDependency: @webpieces/openapi-generator >= 0.4.812');
    });

    it('prefers the consumer copy over any other, however new the other one is', () => {
        const plugin = specTempDirs.make('wp-consumer-bin-plugin-');
        FakeInstall.at(plugin, '9.9.9');
        const consumer = specTempDirs.make('wp-consumer-bin-consumer-');
        FakeInstall.at(consumer, '0.4.812');

        const bin = resolver.resolve(new ConsumerBinRequest('openapi-generate', OPENAPI_GENERATOR, [consumer]));

        expect(bin.version).toBe('0.4.812');
        expect(bin.packageJson.startsWith(consumer)).toBe(true);
    });

    it('fails the version handshake with the bump as its cure', () => {
        const consumer = specTempDirs.make('wp-consumer-bin-');
        FakeInstall.at(consumer, '0.4.811');

        const message = refusal([consumer]);

        expect(message).toContain('@webpieces/openapi-generator 0.4.811 is installed');
        expect(message).toContain('Fix Option 1: (preferred) Bump the devDependency to @webpieces/openapi-generator >= 0.4.812');
    });

    it('refuses a workspace link (0.0.0-dev): a prerelease is not a release', () => {
        const consumer = specTempDirs.make('wp-consumer-bin-');
        FakeInstall.at(consumer, '0.0.0-dev');

        const message = refusal([consumer]);

        expect(message).toContain('0.0.0-dev');
        expect(message).toContain('@webpieces/openapi-generator >= 0.4.812');
    });

    it('accepts a release equal to the minimum, and any newer minor or major', () => {
        for (const version of ['0.4.812', '0.5.0', '1.0.0']) {
            const consumer = specTempDirs.make('wp-consumer-bin-');
            FakeInstall.at(consumer, version);
            expect(resolver.resolve(new ConsumerBinRequest('openapi-generate', OPENAPI_GENERATOR, [consumer])).version).toBe(version);
        }
    });

    it('refuses an install that declares no bin', () => {
        const consumer = specTempDirs.make('wp-consumer-bin-');
        FakeInstall.at(consumer, '0.4.900', false);

        expect(refusal([consumer])).toContain("declares no runnable 'wp-openapi' bin");
    });
});
