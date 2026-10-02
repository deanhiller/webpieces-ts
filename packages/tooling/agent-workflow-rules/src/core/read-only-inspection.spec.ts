import { ReadOnlyInspectionScan } from './read-only-inspection';

const scan = new ReadOnlyInspectionScan();

describe('ReadOnlyInspectionScan — what may run while webpieces.config.json will not load', () => {
    it.each([
        'cat webpieces.config.json',
        'grep -n "max-file-lines" webpieces.config.json',
        "sed -n '220,240p' webpieces.config.json",
        'head -50 webpieces.config.json',
        'cat webpieces.config.json | head -20',
        'grep -c HEAD webpieces.config.json 2>&1',
        'ls -la',
        'jq . webpieces.config.json',
        'wc -l webpieces.config.json && echo done',
        'cd packages && cat webpieces.config.json',
    ])('allows the inspection command: %s', (command: string) => {
        expect(scan.isReadOnlyInspection(command)).toBe(true);
    });

    it.each([
        'git push origin HEAD',
        'gh pr create --fill',
        'git status',
        'pnpm run build-all',
        'rm webpieces.config.json',
        'echo "{}" > webpieces.config.json',
        'cat template.json >> webpieces.config.json',
        "sed -i '' 's/ON/OFF/' webpieces.config.json",
        'find . -name "*.ts" -delete',
        'find . -name "*.ts" -exec rm {} ;',
        'sort -o out.txt in.txt',
        'cat webpieces.config.json && git push',
        'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"',
        '',
    ])('refuses the non-inspection command: %s', (command: string) => {
        expect(scan.isReadOnlyInspection(command)).toBe(false);
    });
});
