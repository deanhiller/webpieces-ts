import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ProjectInfo } from '../../project-info';
import { WiringSourceExtractor } from '../source-extractor';
import { WiringFormat } from '../wiring-format';
export class Fixture {
    readonly root = specTempDirs.make('wiring-v2-');
    readonly infos = new Map<string, ProjectInfo>();
    readonly files: string[] = [];
    readonly framework = '../../../packages/http/http-routing/src/Wiring';

    constructor() {
        this.write('packages/http/http-routing', 'Wiring.ts', `
            export interface BindingModule { configure(options: object): void; }
            export interface RouteModule { configure(router: WebpiecesRouter): void; }
            export interface Wiring { getBindingModules(): BindingModule[]; getRoutingModules(): RouteModule[]; }
            export interface AppWiring extends Wiring { getWirings(): Wiring[]; }
            export class WebpiecesRouter { addRoutes(api: object, implementation: object): void {} }
            export class WiringPolicy { constructor(public name: string, public enabled: boolean) {} }
        `);
        this.write('packages/http/http-client-node', 'RuntimeClients.ts', 'export class RuntimeClients { bindRpc(token: object, api: object, destination: string): void {} }');
        this.write('contracts', 'api.ts', 'export class SaveApi {} export class AuthApi {}');
    }

    write(project: string, file: string, source: string): void {
        const target = path.join(this.root, project, 'src', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
        this.files.push(target);
        this.infos.set(project, new ProjectInfo(project, project, project === 'app' ? ['webpieces', 'framework:node'] : ['webpieces-lib']));
    }

    source(body: string): string {
        return `import { AppWiring, Wiring, BindingModule, RouteModule, WebpiecesRouter, WiringPolicy } from '../../packages/http/http-routing/src/Wiring';
            import { RuntimeClients } from '../../packages/http/http-client-node/src/RuntimeClients';
            import { SaveApi, AuthApi } from '../../contracts/src/api';
            ${body}`;
    }

    program(): ts.Program {
        return ts.createProgram(this.files, { target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Node10 });
    }

    extract(project: string = 'app'): ReturnType<WiringSourceExtractor['extract']> {
        return new WiringSourceExtractor(this.root, this.infos.get(project)!, this.infos, this.program()).extract();
    }

    format(): string[] {
        const program = this.program();
        return new WiringFormat(program.getTypeChecker(), 200).problems(program.getSourceFile(path.join(this.root, 'app/src/wiring.ts'))!);
    }
}

