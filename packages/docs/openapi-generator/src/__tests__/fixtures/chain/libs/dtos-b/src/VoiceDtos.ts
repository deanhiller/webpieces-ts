/* eslint-disable */
import { SpeakerGenderDto } from './SpeakerGenderDto';

/**
 * Descriptions in every supported language — the SHARED one. `lang-apis` and `fsdb-api` each declare
 * a DIFFERENT type of this same name, which is the `LocalizedDescriptionsDto` case of #1058.
 */
export interface LocalizedDescriptionsDto {
    /** The English description. */
    en: string;
    /** The Spanish description. */
    es?: string;
}

/** One voice a lesson can be read in. */
export interface VoiceChoiceDto {
    /** The voice's identifier. */
    voiceId: string;
    /** Who the voice sounds like. */
    gender: SpeakerGenderDto;
}
