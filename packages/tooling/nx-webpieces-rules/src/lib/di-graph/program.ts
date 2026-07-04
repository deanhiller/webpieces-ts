/**
 * Project Program Factory
 *
 * Creates one ts.Program per project for DI graph analysis. Prefers the compile
 * tsconfig (tsconfig.app.json / tsconfig.lib.json) so the program contains the
 * project's real source set; cross-package classes resolve to SOURCE (not dist
 * d.ts) because tsconfig.base.json paths map @webpieces/* to src/index.ts.
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

const TSCONFIG_CANDIDATES = ['tsconfig.app.json', 'tsconfig.lib.json', 'tsconfig.json'];

export function findProjectTsconfig(projectRootAbs: string): string | null {
    for (const candidate of TSCONFIG_CANDIDATES) {
        const candidatePath = path.join(projectRootAbs, candidate);
        if (fs.existsSync(candidatePath)) return candidatePath;
    }
    return null;
}

/**
 * Create the TypeScript program for a project, or null when the project has no
 * usable tsconfig / no source files (e.g. a package.json-only project).
 */
export function createProjectProgram(projectRootAbs: string): ts.Program | null {
    const configPath = findProjectTsconfig(projectRootAbs);
    if (!configPath) return null;

    const host: ts.ParseConfigFileHost = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic: ts.Diagnostic): void => {
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            throw new Error(`Failed to parse ${configPath}: ${message}`);
        },
    };

    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed || parsed.fileNames.length === 0) return null;

    return ts.createProgram(parsed.fileNames, parsed.options);
}
