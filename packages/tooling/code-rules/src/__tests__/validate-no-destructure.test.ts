import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findDestructuringInFile } from '../validate-no-destructure';

// allowedPaths is the ONLY escape when disableAllowed is false — that setting deliberately converts a
// disabled violation back into a reported one — so every case below runs with disableAllowed: false.
// Testing with disableAllowed: true would pass even with the exemption missing.

const RN_COMPONENT = [
    'export function Transport(props: Props) {',
    '    const [rate, setRate] = useState(1.0);',
    '    return rate;',
    '}',
    'export function Bar(props2: { onPlay: () => void }) { return props2; }',
].join('\n');

describe('findDestructuringInFile — allowedPaths', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-destructure-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(relativePath: string, content: string): string {
        const fullPath = path.join(tmpDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
        return relativePath;
    }

    it('flags React idiom when the file is NOT in allowedPaths', () => {
        const file = writeFile('src/service.ts', RN_COMPONENT);
        expect(findDestructuringInFile(file, tmpDir, false, [])).toHaveLength(1);
    });

    it('ignores a file matched by an allowedPaths glob (React Native tree)', () => {
        const file = writeFile('mobile/lang-android/Transport.tsx', RN_COMPONENT);
        expect(findDestructuringInFile(file, tmpDir, false, ['mobile/**'])).toHaveLength(0);
    });

    it('ignores a file under an allowedPaths directory prefix', () => {
        const file = writeFile('mobile/lang-android/hooks/useThing.ts', RN_COMPONENT);
        expect(findDestructuringInFile(file, tmpDir, false, ['mobile/lang-android'])).toHaveLength(0);
    });

    it('exempts a destructured function parameter under allowedPaths', () => {
        const src = 'export function Transport({ onPlay }: Props) { return onPlay; }\n';
        expect(findDestructuringInFile(writeFile('src/svc.ts', src), tmpDir, false, [])).toHaveLength(1);
        expect(findDestructuringInFile(writeFile('mobile/ui/Comp.tsx', src), tmpDir, false, ['mobile/**'])).toHaveLength(0);
    });

    it('still flags a file outside the allowedPaths glob', () => {
        const file = writeFile('apps/server/thing.ts', RN_COMPONENT);
        expect(findDestructuringInFile(file, tmpDir, false, ['mobile/**'])).toHaveLength(1);
    });

    it('matches on the repo-relative path, not the absolute one', () => {
        // A guard applied after path.join(workspaceRoot, file) would never match `mobile/**`.
        const file = writeFile('mobile/deep/nested/Comp.tsx', RN_COMPONENT);
        expect(path.isAbsolute(file)).toBe(false);
        expect(findDestructuringInFile(file, tmpDir, false, ['mobile/**'])).toHaveLength(0);
    });
});
