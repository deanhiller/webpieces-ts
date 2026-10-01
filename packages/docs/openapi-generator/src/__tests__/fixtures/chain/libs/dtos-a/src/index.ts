/* eslint-disable */
import { SpeakerGenderDto, VoiceChoiceDto } from '@fixture/dtos-b';

/** How a lesson is built. */
export enum LessonTypeDto {
    TRAINING = 'training',
    NUMBERED = 'numbered',
}

/** The fields every lesson request carries — extended across a package boundary. */
export interface LessonScopedDto {
    /** The lesson, 1-100. */
    lessonNumber: number;
    /** How the lesson is built. */
    lessonType: LessonTypeDto;
}

/** One passage of a lesson. */
export interface PassageItemDto {
    /** The passage's identifier. */
    passageId: string;
    /** The voice it is read in. */
    voice: VoiceChoiceDto;
    /** Who narrates it. */
    narrator: SpeakerGenderDto;
}

/** A generic page has no schema until it is instantiated, so it is left out of the document. */
export interface PageDto<T> {
    /** The items. */
    items: T[];
}
