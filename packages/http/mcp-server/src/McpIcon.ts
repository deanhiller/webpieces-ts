import { Icon } from '@modelcontextprotocol/server';

/** Immutable standard MCP icon descriptor. URI validation never fetches image bytes. */
export class McpIcon implements Icon {
    readonly sizes?: string[];

    constructor(
        public readonly src: string,
        public readonly mimeType?: string,
        sizes?: readonly string[],
        public readonly theme?: 'light' | 'dark',
    ) {
        this.validateSource(src);
        if (mimeType !== undefined && !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
            this.invalid('mimeType must be an image MIME type');
        }
        if (theme !== undefined && theme !== 'light' && theme !== 'dark') {
            this.invalid('theme must be light or dark');
        }
        if (sizes !== undefined) {
            if (
                !Array.isArray(sizes) ||
                !sizes.every(
                    (size: string) =>
                        typeof size === 'string' && /^(any|[1-9]\d*x[1-9]\d*)$/.test(size),
                )
            ) {
                this.invalid('sizes must contain dimensions such as 128x128 or any');
            }
            this.sizes = [...sizes];
            Object.freeze(this.sizes);
        }
        Object.freeze(this);
    }

    private validateSource(src: string): void {
        if (typeof src !== 'string' || src.trim() !== src || !URL.canParse(src)) {
            this.invalid('src must be an absolute HTTPS image URL or base64 image data URI');
        }
        const url = new URL(src);
        if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return;
        if (
            /^data:image\/[a-z0-9.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(
                src,
            ) &&
            src.slice(src.indexOf(',') + 1).length > 0
        )
            return;
        this.invalid('src must use HTTPS without credentials or a non-empty base64 image data URI');
    }

    private invalid(reason: string): never {
        throw new Error(`WpMcpServerConfig.setIcons(...): ${reason}.`);
    }

    /** Copies caller-owned descriptors and nested size arrays before freezing the snapshot. */
    static snapshot(icons: readonly Icon[]): readonly McpIcon[] {
        if (!Array.isArray(icons)) {
            throw new Error(
                'WpMcpServerConfig.setIcons(...) requires an array of icon descriptors.',
            );
        }
        return Object.freeze(
            icons.map((icon: Icon) => {
                if (!icon || typeof icon !== 'object') {
                    throw new Error('WpMcpServerConfig.setIcons(...) requires icon descriptors.');
                }
                return new McpIcon(icon.src, icon.mimeType, icon.sizes, icon.theme);
            }),
        );
    }
}
