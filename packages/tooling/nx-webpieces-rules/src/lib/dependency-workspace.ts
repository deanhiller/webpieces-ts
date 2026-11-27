import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import { parse } from 'yaml';

export class DependencyManifest {
    name?: string;
    private?: boolean;
    types?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

export class WorkspaceCatalog {
    packages?: string[];
    catalog?: Record<string, string>;
    catalogs?: Record<string, Record<string, string>>;
}

export class DependencyOwner {
    constructor(
        readonly directory: string,
        readonly manifest: DependencyManifest | undefined,
    ) {}
}

const EXCLUDED = new Set([
    'node_modules',
    'dist',
    'build',
    'coverage',
    'tmp',
    'out-tsc',
    'android',
    'ios',
]);

/** One bounded workspace traversal; nested repositories and symlinks are never governed. */
export class DependencyWorkspace {
    readonly files: string[] = [];
    readonly owners: DependencyOwner[] = [];
    readonly catalog: WorkspaceCatalog;
    readonly rootManifest: DependencyManifest;

    constructor(readonly root: string) {
        this.catalog = parse(
            fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
        ) as WorkspaceCatalog;
        this.rootManifest = this.manifest('.');
        this.walk('.');
        this.loadOwners();
    }

    matches(file: string, patterns: readonly string[]): boolean {
        let included = false;
        for (const pattern of patterns) {
            if (pattern.startsWith('!')) {
                if (minimatch(file, pattern.slice(1), { dot: true })) included = false;
            } else if (minimatch(file, pattern, { dot: true })) included = true;
        }
        return included;
    }

    owner(file: string): DependencyOwner {
        const owner = this.owners.find((entry: DependencyOwner) =>
            file.startsWith(entry.directory + '/'),
        );
        return owner ?? new DependencyOwner('.', this.rootManifest);
    }

    manifest(directory: string): DependencyManifest {
        return JSON.parse(
            fs.readFileSync(path.join(this.root, directory, 'package.json'), 'utf8'),
        ) as DependencyManifest;
    }

    private loadOwners(): void {
        const directories = new Set<string>();
        for (const file of this.files) {
            if (path.basename(file) === 'project.json') directories.add(path.dirname(file));
            if (
                path.basename(file) === 'package.json' &&
                this.matches(path.dirname(file), this.catalog.packages ?? [])
            )
                directories.add(path.dirname(file));
        }
        for (const directory of directories) {
            const managed = this.matches(directory, this.catalog.packages ?? []);
            const exists = fs.existsSync(path.join(this.root, directory, 'package.json'));
            this.owners.push(
                new DependencyOwner(
                    directory,
                    managed && exists ? this.manifest(directory) : undefined,
                ),
            );
        }
        this.owners.sort(
            (a: DependencyOwner, b: DependencyOwner) => b.directory.length - a.directory.length,
        );
    }

    private walk(relative: string): void {
        const directory = path.join(this.root, relative);
        if (relative !== '.' && fs.existsSync(path.join(directory, '.git'))) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || EXCLUDED.has(entry.name)) continue;
            const file = relative === '.' ? entry.name : relative + '/' + entry.name;
            if (entry.isDirectory()) this.walk(file);
            else if (entry.isFile()) this.files.push(file);
        }
    }
}
