import { describe, expect, it } from 'vitest';
import { Icon, McpIcon, WpMcpServerConfig } from './index';

describe('MCP icon configuration', () => {
    it('copies and freezes descriptors and nested arrays', () => {
        const sizes = ['128x128'];
        const icon: Icon = { src: 'https://api.example.test/icon.png', sizes };
        const icons = [icon];
        const config = new WpMcpServerConfig<string>();
        expect(config.icons).toBeUndefined();
        expect(config.setIcons(icons)).toBe(config);
        icon.src = 'https://other.example/icon.png';
        sizes.push('64x64');
        icons.length = 0;
        expect(config.icons).toEqual([
            new McpIcon('https://api.example.test/icon.png', undefined, ['128x128']),
        ]);
        expect(Object.isFrozen(config.icons)).toBe(true);
        expect(Object.isFrozen(config.icons?.[0])).toBe(true);
        expect(Object.isFrozen(config.icons?.[0].sizes)).toBe(true);
        config.setIcons([]);
        expect(config.icons).toEqual([]);
    });

    it.each([
        '',
        'relative.png',
        'http://example.test/icon.png',
        'javascript:alert(1)',
        'file:///icon.png',
        'ftp://example.test/icon.png',
        'ws://example.test/icon.png',
        'https://user:secret@example.test/icon.png',
        ' https://example.test/icon.png',
        'data:text/html;base64,aGk=',
        'data:image/png;base64,',
        'data:image/png;base64,!!!',
        'data:image/png,plain',
    ])('rejects unsafe or malformed source %s without fetching it', (src: string) => {
        expect(() => new WpMcpServerConfig<string>().setIcons([{ src }])).toThrow('setIcons');
    });

    it('validates descriptor fields and keeps the last valid snapshot on failure', () => {
        const config = new WpMcpServerConfig<string>().setIcons([
            new McpIcon('https://example.test/icon.png'),
        ]);
        expect(() =>
            config.setIcons([{ src: 'https://example.test/icon.png', mimeType: 'text/html' }]),
        ).toThrow('mimeType');
        expect(() =>
            config.setIcons([{ src: 'https://example.test/icon.png', sizes: ['0x0'] }]),
        ).toThrow('sizes');
        expect(() =>
            config.setIcons([{ src: 'https://example.test/icon.png', sizes: ['128'] }]),
        ).toThrow('sizes');
        expect(config.icons?.[0].src).toBe('https://example.test/icon.png');
        expect(
            new McpIcon('data:image/svg+xml;base64,PHN2Zy8+', 'image/svg+xml', ['any']).sizes,
        ).toEqual(['any']);
    });
});
