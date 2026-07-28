import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoClientCreationOutsideServerOrClientConfig } from '@webpieces/rules-config';

import { NoClientCreationOutsideServerOrClientValidator } from './validate-no-client-creation-outside-server-or-client';
import { ProjectRoleResolver } from './project-role-resolver';

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function writeFile(root: string, relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
}

function config(overrides: Partial<NoClientCreationOutsideServerOrClientConfig>): NoClientCreationOutsideServerOrClientConfig {
    const c = new NoClientCreationOutsideServerOrClientConfig();
    c.mode = 'NEW_AND_MODIFIED_FILES';
    c.ignoreModifiedUntilEpoch = 0;
    Object.assign(c, overrides);
    return c;
}

const RPC_CALL = `export class Wiring {
  build(factory: ClientHttpFactory) {
    return factory.createRpcClient(SomeApi, new ClientConfig('svc'));
  }
}`;

describe('NoClientCreationOutsideServerOrClientValidator', () => {
    let root: string;
    let base: string;
    const validator = (c: NoClientCreationOutsideServerOrClientConfig): NoClientCreationOutsideServerOrClientValidator =>
        new NoClientCreationOutsideServerOrClientValidator(c, new ProjectRoleResolver());

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-client-creation-')));
        git(root, 'init -q -b main');
        git(root, 'config user.email test@test.com');
        git(root, 'config user.name test');
        writeFile(root, 'placeholder.txt', 'x\n');
        git(root, 'add -A');
        git(root, 'commit -q -m base');
        base = git(root, 'rev-parse HEAD');
        process.env['NX_BASE'] = base;
        delete process.env['NX_HEAD'];
    });

    afterEach(() => {
        delete process.env['NX_BASE'];
        fs.rmSync(root, { recursive: true, force: true });
    });

    function addProject(dir: string, role: string, srcRel: string, src: string): void {
        writeFile(root, `${dir}/project.json`, JSON.stringify({ name: path.basename(dir), tags: [`role:${role}`] }));
        writeFile(root, `${dir}/${srcRel}`, src);
    }

    it('warns (build passes) when a role:lib constructs an rpc client', async () => {
        addProject('libs/core-angular', 'lib', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'warn' })).run(root);
        expect(result.success).toBe(true);
    });

    it('fails the build when severity is error and a role:lib constructs a client', async () => {
        addProject('libs/core-angular', 'lib', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(false);
    });

    it('flags createPubSubClient the same as createRpcClient', async () => {
        addProject('libs/tasks', 'lib', 'src/wiring.ts',
            `const c = factory.createPubSubClient(EmailApi, new TaskClientConfig('email'));`);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(false);
    });

    it('does not flag a role:server that constructs a client', async () => {
        addProject('servers/save', 'server', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('does not flag a role:client (angular app) that constructs a client', async () => {
        addProject('apps/web', 'client', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('does not flag a lib that only IMPORTS/injects the api (no createRpcClient call)', async () => {
        addProject('libs/service', 'lib', 'src/LoginService.ts',
            `import { AuthStoreApi } from '@x/apis';\nexport class LoginService { constructor(private readonly api: AuthStoreApi) {} }`);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('does not flag a createRpcClient that appears only in a JSDoc/comment example', async () => {
        addProject('libs/docs', 'lib', 'src/Factory.ts',
            `/**\n * const client = factory.createRpcClient(SomeApi, new ClientConfig('svc'));\n */\nexport class Factory {}`);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('skips a project that has no role tag (role-tag rule owns that)', async () => {
        writeFile(root, 'libs/untagged/project.json', JSON.stringify({ name: 'untagged', tags: [] }));
        writeFile(root, 'libs/untagged/src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('honors allowedRoles overrides (designed-lib allowed)', async () => {
        addProject('libs/designed', 'designed-lib', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'error', allowedRoles: ['server', 'client', 'app', 'designed-lib'] })).run(root);
        expect(result.success).toBe(true);
    });

    it('exempts files under allowedPaths', async () => {
        addProject('libs/core-angular', 'lib', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ severity: 'error', allowedPaths: ['libs/core-angular/**'] })).run(root);
        expect(result.success).toBe(true);
    });

    it('is suppressed by a webpieces-disable comment on the line', async () => {
        addProject('libs/core-angular', 'lib', 'src/wiring.ts',
            `const c = factory.createRpcClient(SomeApi, config); // webpieces-disable no-client-creation-outside-server-or-client -- legacy`);
        const result = await validator(config({ severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('mode OFF short-circuits to success', async () => {
        addProject('libs/core-angular', 'lib', 'src/wiring.ts', RPC_CALL);
        const result = await validator(config({ mode: 'OFF', severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });

    it('NEW_AND_MODIFIED_CODE only flags a creation site on a changed line', async () => {
        // Commit the file with the client-creation call already present, then change an UNRELATED line.
        addProject('libs/core-angular', 'lib', 'src/wiring.ts',
            `const c = factory.createRpcClient(SomeApi, cfg);\nexport const other = 1;\n`);
        git(root, 'add -A');
        git(root, 'commit -q -m addfile');
        const newBase = git(root, 'rev-parse HEAD');
        process.env['NX_BASE'] = newBase;
        // Touch only the 'other' line — the createRpcClient line is unchanged.
        writeFile(root, 'libs/core-angular/src/wiring.ts',
            `const c = factory.createRpcClient(SomeApi, cfg);\nexport const other = 2;\n`);
        const result = await validator(config({ mode: 'NEW_AND_MODIFIED_CODE', severity: 'error' })).run(root);
        expect(result.success).toBe(true);
    });
});
