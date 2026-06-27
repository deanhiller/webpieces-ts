import { execSync } from 'child_process';

export function getFeatureName(): string {
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    return branch.replace(/\//g, '-').replace(/Squash$/, '');
}

export async function main(): Promise<void> {
    process.stdout.write(getFeatureName() + '\n');
}

if (require.main === module) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
