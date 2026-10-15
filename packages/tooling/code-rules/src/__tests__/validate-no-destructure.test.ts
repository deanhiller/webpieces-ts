import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { findDestructuringInFile } from '../validate-no-destructure';


// Every case runs with disableAllowed: false, the setting under which a path exclusion is the ONLY
// escape. That exclusion is no longer the rule's: the framework-owned excludePaths drops the file from
// the rule's listing before it runs (#1253, proven in rule-exclusions.spec.ts), so the rule judges
// every file it is handed.

const RN_COMPONENT = [
    'export function Transport(props: Props) {',
    '    const [rate, setRate] = useState(1.0);',
    '    return rate;',
    '}',
    'export function Bar(props2: { onPlay: () => void }) { return props2; }',
].join('\n');

describe('findDestructuringInFile — judges every file it is handed', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = specTempDirs.make('no-destructure-');
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

    it('flags the React idiom', () => {
        const file = writeFile('src/service.ts', RN_COMPONENT);
        expect(findDestructuringInFile(file, tmpDir, false)).toHaveLength(1);
    });

    it('flags a destructured function parameter', () => {
        const src = 'export function Transport({ onPlay }: Props) { return onPlay; }\n';
        expect(findDestructuringInFile(writeFile('src/svc.ts', src), tmpDir, false)).toHaveLength(1);
    });

    it('applies no path exemption of its own — a React Native tree is excluded by excludePaths upstream', () => {
        const file = writeFile('mobile/lang-android/Transport.tsx', RN_COMPONENT);
        expect(findDestructuringInFile(file, tmpDir, false)).toHaveLength(1);
    });
});
