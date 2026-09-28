/**
 * A PUBLISHED package, as an npm consumer installs it: declarations only, JSDoc kept, decorators
 * gone. The shape `tsc --declaration` emits for ctoteachings/monorepo's `@myorg/auth-dtos` (#1055).
 */

/** An AI provider a learner can connect. */
export type AiProvider = 'claude' | 'chatgpt';

/** The settings a learner can change while offline. */
export declare class OfflineSettingsDto {
    /** Whether lessons are downloaded for offline use. */
    offlineEnabled: boolean;
    /** At most this many lessons are kept on the device. */
    maxOfflineLessons?: number;
}
