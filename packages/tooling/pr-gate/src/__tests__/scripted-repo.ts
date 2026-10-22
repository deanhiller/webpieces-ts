import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GitResultDto } from '@webpieces/tooling-common';
import { checkoutLayout, MockGitProcessApi, ProcessCallDto } from '@webpieces/tooling-testkit';

/** One commit of a {@link ScriptedRepo}: its parent and the full tree it records. Data only. */
export class RepoCommit {
    constructor(
        readonly sha: string,
        readonly parent: string | null,
        readonly tree: ReadonlyMap<string, string>,
    ) {}
}

/**
 * A git repository with NO git (#1381): commits, branches and the index live in memory, the working tree is
 * the real scratch directory on disk. The mocked git edge answers the review pipeline's commands from it —
 * the fork point, `status --porcelain`, `diff [--name-only]`, `ls-files --others`, `merge-base
 * --is-ancestor`, `branch --show-current` — exactly as git would for the same history, so a spec states its
 * scenario as edits and commits and the production code reads them through the edge it reads git through.
 *
 * There is no `origin` remote: `origin/main` does not resolve, as in a fresh local repo. An argv this model
 * does not know THROWS, naming it — a feature test must never inherit an accidental answer.
 */
export class ScriptedRepo {
    private readonly commits = new Map<string, RepoCommit>();
    private readonly branches = new Map<string, string>();
    private index = new Map<string, string>();
    private current: string;
    private seq = 0;

    private constructor(readonly root: string, branch: string) {
        this.current = branch;
    }

    /** `git init -b <branch>` in `root`, answering every git call `git` receives. */
    static init(root: string, branch: string, git: MockGitProcessApi): ScriptedRepo {
        checkoutLayout.primary(root, branch);
        const repo = new ScriptedRepo(root, branch);
        git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => repo.answer(call));
        return repo;
    }

    write(file: string, body: string): void {
        const abs = path.join(this.root, file);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }

    /** `git add -A`: the index becomes the (non-ignored) working tree. */
    addAll(): void {
        this.index = this.workingTree();
    }

    /** `git add <file>`. */
    add(file: string): void {
        const body = this.workingTree().get(file);
        if (body === undefined) this.index.delete(file);
        else this.index.set(file, body);
    }

    /** `git commit` of the index on the current branch. Returns the new sha. */
    commitIndex(message: string): string {
        const parent = this.branches.get(this.current) ?? null;
        const sha = this.newSha(message, parent);
        this.commits.set(sha, new RepoCommit(sha, parent, new Map(this.index)));
        this.branches.set(this.current, sha);
        return sha;
    }

    /** `git add -A && git commit`. */
    commitAll(message: string): string {
        this.addAll();
        return this.commitIndex(message);
    }

    /** `git checkout -b <name>` from HEAD (the working tree and index stay as they are). */
    checkoutNewBranch(name: string): void {
        this.branches.set(name, this.headSha());
        this.current = name;
        checkoutLayout.checkoutBranch(this.root, name);
    }

    /** `git reset --soft <branch>`: the current branch moves; the index and working tree do not. */
    resetSoft(branch: string): void {
        this.branches.set(this.current, this.tipOf(branch));
    }

    /**
     * A commit made on `branch` WITHOUT checking it out (a side branch + `git branch -f <branch>`): it adds
     * `file` to that branch's tree and moves the branch; HEAD, the index and the working tree are untouched.
     */
    advanceBranch(branch: string, file: string, body: string, message: string): string {
        const parent = this.tipOf(branch);
        const tree = new Map(this.commit(parent).tree);
        tree.set(file, body);
        const sha = this.newSha(message, parent);
        this.commits.set(sha, new RepoCommit(sha, parent, tree));
        this.branches.set(branch, sha);
        return sha;
    }

    headSha(): string {
        return this.tipOf(this.current);
    }

    answer(call: ProcessCallDto): GitResultDto {
        const args = call.args;
        const line = args.join(' ');
        if (line === 'branch --show-current') return this.ok(`${this.current}\n`);
        if (line === 'rev-parse HEAD') return this.revParse(this.current);
        if (line === 'rev-parse origin/main') return this.revParse('origin/main');
        if (line === 'status --porcelain --untracked-files=all') return this.ok(this.status());
        if (line === 'ls-files --others --exclude-standard') return this.ok(this.lines(this.untracked()));
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return this.isAncestor(args[2], args[3]);
        if (args[0] === 'merge-base' && args.length === 3 && args[2] === 'HEAD') return this.mergeBase(args[1]);
        if (args[0] === 'diff') return this.diff(args.slice(1));
        throw new Error(`ScriptedRepo does not model \`git ${line}\` (cwd ${call.cwd ?? '<inherited>'}).`);
    }

    // ─── the answers ────────────────────────────────────────────────────────────────────────────────

    private revParse(ref: string): GitResultDto {
        const sha = this.branches.get(ref);
        if (sha === undefined) {
            return new GitResultDto(128, `${ref}\n`, `fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`);
        }
        return this.ok(`${sha}\n`);
    }

    private mergeBase(ref: string): GitResultDto {
        const left = this.branches.get(ref);
        const right = this.branches.get(this.current);
        if (left === undefined || right === undefined) return new GitResultDto(128, '', `fatal: Not a valid object name ${ref}`);
        const ancestors = new Set(this.chain(left));
        const common = this.chain(right).find((sha: string): boolean => ancestors.has(sha));
        return common === undefined ? new GitResultDto(1, '', '') : this.ok(`${common}\n`);
    }

    private isAncestor(sha: string, of: string): GitResultDto {
        if (!this.commits.has(sha)) return new GitResultDto(128, '', `fatal: Not a valid commit name ${sha}`);
        const tip = of === 'HEAD' ? this.headSha() : this.tipOf(of);
        return new GitResultDto(this.chain(tip).includes(sha) ? 0 : 1, '', '');
    }

    /** `diff [--name-only] [--diff-filter=d] <base> [<head>]` — a pathspec is not modelled. */
    private diff(rest: string[]): GitResultDto {
        if (rest.includes('--')) throw new Error(`ScriptedRepo does not model a pathspec: git diff ${rest.join(' ')}`);
        const nameOnly = rest.includes('--name-only');
        const dropDeletions = rest.includes('--diff-filter=d');
        const refs = rest.filter((arg: string): boolean => !arg.startsWith('--'));
        const before = this.commit(refs[0]).tree;
        const after = refs.length > 1 ? this.commit(refs[1]).tree : this.trackedWorkingTree();
        const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
            .filter((file: string): boolean => before.get(file) !== after.get(file))
            .filter((file: string): boolean => !dropDeletions || after.has(file));
        if (nameOnly) return this.ok(this.lines(paths));
        return this.ok(paths.map((file: string): string => this.patch(file, before.get(file), after.get(file))).join(''));
    }

    private patch(file: string, before: string | undefined, after: string | undefined): string {
        const removed = before === undefined ? [] : before.replace(/\n$/, '').split('\n').map((l: string): string => `-${l}`);
        const added = after === undefined ? [] : after.replace(/\n$/, '').split('\n').map((l: string): string => `+${l}`);
        const from = before === undefined ? '/dev/null' : `a/${file}`;
        const to = after === undefined ? '/dev/null' : `b/${file}`;
        return `diff --git a/${file} b/${file}\n--- ${from}\n+++ ${to}\n@@ -1,${removed.length} +1,${added.length} @@\n`
            + [...removed, ...added].map((l: string): string => `${l}\n`).join('');
    }

    /** Porcelain v1: tracked changes (index column, then work-tree column), then `??` untracked. */
    private status(): string {
        const head = this.headTree();
        const work = this.workingTree();
        const tracked = [...new Set([...head.keys(), ...this.index.keys()])].sort();
        const out: string[] = [];
        for (const file of tracked) {
            const x = this.column(head.get(file), this.index.get(file), 'A');
            const y = this.index.has(file) ? this.column(this.index.get(file), work.get(file), '?') : ' ';
            if (x !== ' ' || y !== ' ') out.push(`${x}${y} ${file}`);
        }
        for (const file of this.untracked()) out.push(`?? ${file}`);
        return this.lines(out);
    }

    private column(from: string | undefined, to: string | undefined, added: string): string {
        if (from === undefined && to === undefined) return ' ';
        if (from === undefined) return added;
        if (to === undefined) return 'D';
        return from === to ? ' ' : 'M';
    }

    private untracked(): string[] {
        return [...this.workingTree().keys()].filter((file: string): boolean => !this.index.has(file)).sort();
    }

    // ─── the model ──────────────────────────────────────────────────────────────────────────────────

    /** What `git diff <commit>` compares against: every TRACKED path, as it is on disk now. */
    private trackedWorkingTree(): Map<string, string> {
        const work = this.workingTree();
        const out = new Map<string, string>();
        for (const file of this.index.keys()) {
            const body = work.get(file);
            if (body !== undefined) out.set(file, body);
        }
        return out;
    }

    /** Every non-ignored file under the root (`.git` excluded), read from disk. */
    private workingTree(): Map<string, string> {
        const ignored = this.ignorePatterns();
        const out = new Map<string, string>();
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name);
                const rel = path.relative(this.root, abs).split(path.sep).join('/');
                if (rel === '.git' || ignored.some((p: string): boolean => rel === p || rel.startsWith(`${p}/`))) continue;
                if (entry.isDirectory()) walk(abs);
                else out.set(rel, fs.readFileSync(abs, 'utf8'));
            }
        };
        walk(this.root);
        return out;
    }

    // `.gitignore` directory lines (`.webpieces/`) and plain names, rooted at the repo — all these specs use.
    private ignorePatterns(): string[] {
        const file = path.join(this.root, '.gitignore');
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').split('\n').map((l: string): string => l.trim().replace(/\/$/, ''))
            .filter((l: string): boolean => l !== '' && !l.startsWith('#'));
    }

    private headTree(): ReadonlyMap<string, string> {
        const sha = this.branches.get(this.current);
        return sha === undefined ? new Map<string, string>() : this.commit(sha).tree;
    }

    private chain(sha: string): string[] {
        const out: string[] = [];
        for (let at: string | null = sha; at !== null; at = this.commit(at).parent) out.push(at);
        return out;
    }

    private commit(ref: string): RepoCommit {
        const found = this.commits.get(this.branches.get(ref) ?? ref);
        if (found === undefined) throw new Error(`ScriptedRepo: unknown revision ${ref}`);
        return found;
    }

    private tipOf(branch: string): string {
        const sha = this.branches.get(branch);
        if (sha === undefined) throw new Error(`ScriptedRepo: branch ${branch} has no commits`);
        return sha;
    }

    private newSha(message: string, parent: string | null): string {
        this.seq += 1;
        return crypto.createHash('sha1').update(`${String(this.seq)}\0${message}\0${parent ?? ''}`).digest('hex');
    }

    private lines(list: readonly string[]): string {
        return list.map((l: string): string => `${l}\n`).join('');
    }

    private ok(stdout: string): GitResultDto {
        return new GitResultDto(0, stdout, '');
    }
}
