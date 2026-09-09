// webpieces-disable no-anonymous-object-literals -- TypeScript compiler and Metro configuration use their public structural option APIs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ts from 'typescript';
import { ReactNativeCompatibility } from '../packages/tooling/code-rules/src/react-native-compatibility';

/** Runs against actual build outputs, never tsconfig source aliases, for the portable public entrypoints. */
class ReactNativeGate {
    private readonly root = process.cwd();
    private readonly checker = new ReactNativeCompatibility();
    private readonly projects = ['core-util', 'ipc-bridge'];

    async run(): Promise<void> {
        this.validateProjects();
        if (process.argv.includes('--validate-targets')) return;
        const name = process.argv[2];
        if (!this.projects.includes(name))
            throw new Error(`Unknown RN compatibility project: ${name}`);
        const projectRoot = `packages/core/${name}`;
        const config = ts.readConfigFile(
            path.join(this.root, 'tsconfig.base.json'),
            ts.sys.readFile,
        );
        const options = ts.parseJsonConfigFileContent(config.config, ts.sys, this.root).options;
        const entries =
            name === 'core-util' ? ['src/errors/index.ts', 'src/ipc/index.ts'] : ['src/index.ts'];
        this.refuse(
            this.checker.inspect(
                entries.map((entry) => path.join(this.root, projectRoot, entry)),
                options,
            ),
        );
        const fixture = path.join(this.root, '.nx', 'rn-compat', name);
        fs.mkdirSync(fixture, { recursive: true });
        this.stagePackages(fixture);
        const entry = path.join(fixture, 'consumer.ts');
        const source = this.consumer(name);
        fs.writeFileSync(entry, source);
        for (const environment of ['react-native', 'browser', 'node'])
            this.checkDeclarations(entry, environment);
        // Metro consumes the JavaScript equivalent of the SAME public import smoke, emitted by TypeScript.
        const js = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
        }).outputText;
        fs.writeFileSync(path.join(fixture, 'consumer.js'), js);
        // Metro exposes a JavaScript API; loaded only for this Node build tool, never in portable packages.
        const metro = require('metro');
        const base = await metro.loadConfig(
            { cwd: this.root },
            {
                projectRoot: fixture,
                watchFolders: [path.join(this.root, 'dist'), path.join(this.root, 'node_modules')],
                maxWorkers: 1,
                resolver: {
                    nodeModulesPaths: [
                        path.join(fixture, 'node_modules'),
                        path.join(this.root, 'node_modules'),
                    ],
                    useWatchman: false,
                },
            },
        );
        for (const platform of ['android', 'ios']) {
            const bundle = path.join(fixture, `${platform}.js`);
            await metro.runBuild(base, {
                entry: 'consumer.js',
                out: bundle,
                platform,
                dev: false,
                minify: true,
            });
            const compiler = this.hermesCompiler();
            const compiled = spawnSync(
                compiler,
                ['-emit-binary', '-out', `${bundle}.hbc`, bundle],
                { encoding: 'utf8' },
            );
            const compilerLog = `${bundle}.hermes.log`;
            fs.writeFileSync(compilerLog, (compiled.stdout ?? '') + (compiled.stderr ?? ''));
            if (compiled.error) throw compiled.error;
            if (compiled.status !== 0)
                throw new Error(`Hermes compilation failed; see ${compilerLog}`);
            // A compiler-only distribution may advertise -exec but refuse execution. Do not call that a runtime test.
            console.log(
                `RN compatibility: ${name} ${platform} Metro bundle and Hermes bytecode compiled`,
            );
        }
        console.log(
            `RN compatibility: ${name} public declarations pass React Native (no Node/DOM ambient types), browser and Node consumers`,
        );
    }

    private validateProjects(): void {
        for (const group of fs.readdirSync(path.join(this.root, 'packages'))) {
            const dir = path.join(this.root, 'packages', group);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const name of fs.readdirSync(dir)) {
                const project = path.join(dir, name, 'project.json');
                if (fs.existsSync(project)) this.refuse(this.checker.validateTarget(project));
            }
        }
    }

    private stagePackages(fixture: string): void {
        const scope = path.join(fixture, 'node_modules', '@webpieces');
        fs.mkdirSync(scope, { recursive: true });
        for (const name of this.projects) {
            const target = path.join(this.root, 'dist', 'packages', 'core', name);
            const manifest = path.join(target, 'package.json');
            if (!fs.existsSync(manifest)) {
                if (name === path.basename(fixture) || name === 'core-util')
                    throw new Error(`Build output missing: ${manifest}`);
                continue;
            }
            const link = path.join(scope, name);
            if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
        }
    }

    private checkDeclarations(entry: string, environment: string): void {
        const options: ts.CompilerOptions = {
            noEmit: true,
            strict: true,
            skipLibCheck: false,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.Node16,
            moduleResolution: ts.ModuleResolutionKind.Node16,
            preserveSymlinks: true,
            lib:
                environment === 'browser'
                    ? ['lib.es2022.d.ts', 'lib.dom.d.ts']
                    : ['lib.es2022.d.ts'],
            types: environment === 'node' ? ['node'] : [],
        };
        const program = ts.createProgram([entry], options);
        const diagnostics = ts.getPreEmitDiagnostics(program);
        this.refuse(
            diagnostics.map(
                (d) =>
                    `${environment}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}${d.file ? ` (${d.file.fileName})` : ''}`,
            ),
        );
    }

    private consumer(name: string): string {
        const errors =
            this.contractFixture() +
            `import { UserError, ApiErrorCodec } from '@webpieces/core-util/errors';\n` +
            `const original = new UserError('passwords do not match');\n` +
            `const restored = ApiErrorCodec.decode(JSON.parse(JSON.stringify(ApiErrorCodec.encode(original))));\n` +
            `if (!(restored instanceof UserError) || restored.message !== original.message) throw new Error('UserError JSON identity lost');\n`;
        if (name === 'core-util')
            return (
                errors +
                `import { IpcCallContext } from '@webpieces/core-util/ipc';\nif (typeof IpcCallContext !== 'function') throw new Error('IPC context missing');\n`
            );
        return (
            errors +
            `import { IpcClientFactory, IpcServerFactory } from '@webpieces/ipc-bridge';\n` +
            `if (typeof IpcClientFactory !== 'function' || typeof IpcServerFactory !== 'function') throw new Error('Duplex IPC factories missing');\n`
        );
    }

    private contractFixture(): string {
        return (
            `import { IpcMethods } from '@webpieces/core-util/ipc';\n` +
            `abstract class FixtureApi { abstract execute(request: object): Promise<void>; }\n` +
            `function checkMetadataExhaustiveness(): void {\n` +
            `// @ts-expect-error Every declared API method must have metadata.\n` +
            `const missing: IpcMethods<FixtureApi> = {}; void missing;\n` +
            `}\n`
        );
    }

    private hermesCompiler(): string {
        const packageRoot = path.dirname(require.resolve('hermes-compiler/package.json'));
        const platform =
            process.platform === 'darwin'
                ? 'osx-bin'
                : process.platform === 'linux'
                  ? 'linux64-bin'
                  : 'win64-bin';
        return path.join(
            packageRoot,
            'hermesc',
            platform,
            process.platform === 'win32' ? 'hermesc.exe' : 'hermesc',
        );
    }

    private refuse(problems: string[]): void {
        if (problems.length)
            throw new Error(`React Native compatibility failed:\n${problems.join('\n')}`);
    }
}

// webpieces-disable no-any-unknown -- rejected promises may carry any thrown value
new ReactNativeGate().run().catch((error: unknown): void => {
    console.error(error);
    process.exitCode = 1;
});
