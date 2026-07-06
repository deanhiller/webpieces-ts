/**
 * Date/Time DTOs and Utilities for JSON serialization (inspired by Java Time / JSR-310)
 *
 * DTOs are simple interfaces - just data, no logic!
 * Utilities provide conversion logic.
 *
 * Design Philosophy:
 * - DTOs are plain objects with { value: string } - perfect for JSON.stringify/parse
 * - Utilities contain ALL conversion logic (no business logic in DTOs)
 * - Store as ISO-8601 strings (human-readable, unambiguous, sortable)
 * - Always use UTC for timestamps (avoid timezone confusion)
 *
 * References:
 * - Java Time API (JSR-310): https://docs.oracle.com/javase/8/docs/api/java/time/package-summary.html
 * - ISO-8601: https://www.iso.org/iso-8601-date-and-time-format.html
 * - REST API Best Practices: https://www.moesif.com/blog/technical/timestamp/manage-datetime-timestamp-timezones-in-api/
 */

// ============================================================
// DTOs (Data Transfer Objects) - Pure data, no logic
// ============================================================

/**
 * InstantDto - Represents an absolute point in time (UTC).
 *
 * Equivalent to Java's java.time.Instant or JavaScript's Date.
 *
 * **Use cases:**
 * - Timestamps (createdAt, updatedAt, lastModified)
 * - Audit logs
 * - Event timestamps
 * - Any absolute point in time
 *
 * **JSON format:** ISO-8601 string with UTC timezone (Z suffix)
 * - Example: "2024-12-03T14:30:00.000Z"
 *
 * @example
 * ```typescript
 * const now = InstantUtil.now();
 * const json = JSON.stringify({ timestamp: now });
 * // {"timestamp":{"value":"2024-12-03T14:30:00.000Z"}}
 *
 * const parsed = JSON.parse(json);
 * const date = InstantUtil.toDate(parsed.timestamp);
 * ```
 */
export interface InstantDto {
    /**
     * ISO-8601 string in UTC with Z suffix.
     * Example: "2024-12-03T14:30:00.000Z"
     */
    value: string;
}

/**
 * DateDto - Represents a date without time or timezone (e.g., 2024-12-03).
 *
 * Equivalent to Java's java.time.LocalDate.
 *
 * **Use cases:**
 * - Birth dates
 * - Holidays
 * - Calendar dates
 * - Any date where time/timezone is irrelevant
 *
 * **JSON format:** ISO-8601 date string (YYYY-MM-DD)
 * - Example: "2024-12-03"
 *
 * @example
 * ```typescript
 * const christmas = DateUtil.of(2024, 12, 25);
 * const json = JSON.stringify({ birthDate: christmas });
 * // {"birthDate":{"value":"2024-12-25"}}
 * ```
 */
export interface DateDto {
    /**
     * ISO-8601 date string (YYYY-MM-DD).
     * Example: "2024-12-03"
     */
    value: string;
}

/**
 * TimeDto - Represents a time without date or timezone (e.g., 14:30:00.123).
 *
 * Equivalent to Java's java.time.LocalTime.
 *
 * **Use cases:**
 * - Opening/closing hours (e.g., "Store opens at 09:00")
 * - Recurring event times (e.g., "Daily standup at 10:00")
 * - Alarm times
 * - Precise timing measurements
 * - Any time where date/timezone is irrelevant
 *
 * **JSON format:** ISO-8601 time string with milliseconds (HH:mm:ss.SSS)
 * - Example: "14:30:00.123"
 *
 * @example
 * ```typescript
 * const lunch = TimeUtil.of(12, 30, 0, 500);
 * const json = JSON.stringify({ openingTime: lunch });
 * // {"openingTime":{"value":"12:30:00.500"}}
 * ```
 */
export interface TimeDto {
    /**
     * ISO-8601 time string with milliseconds (HH:mm:ss.SSS).
     * Example: "14:30:00.123"
     */
    value: string;
}

/**
 * DateTimeDto - Represents a date and time without timezone (e.g., 2024-12-03T14:30:00.123).
 *
 * Equivalent to Java's java.time.LocalDateTime.
 *
 * **⚠️ WARNING: Use with caution!**
 * "LocalDateTime does not have a time zone, so if you use JSON to send date/time info,
 * you might get in trouble if the client interprets the lack of time zone as default UTC
 * (or its own time zone)."
 *
 * **Use cases:**
 * - Appointment times (when timezone is implied by context)
 * - Event dates/times (when all participants are in same timezone)
 * - **Prefer InstantDto for most use cases to avoid timezone confusion!**
 *
 * **JSON format:** ISO-8601 datetime string without timezone (milliseconds optional)
 * - Example: "2024-12-03T14:30:00" or "2024-12-03T14:30:00.123"
 *
 * @example
 * ```typescript
 * const meeting = DateTimeUtil.of(2024, 12, 3, 14, 30, 0, 500);
 * const json = JSON.stringify({ appointmentTime: meeting });
 * // {"appointmentTime":{"value":"2024-12-03T14:30:00.500"}}
 * ```
 */
export interface DateTimeDto {
    /**
     * ISO-8601 datetime string without timezone (YYYY-MM-DDTHH:mm:ss or YYYY-MM-DDTHH:mm:ss.SSS).
     * Example: "2024-12-03T14:30:00" or "2024-12-03T14:30:00.123"
     */
    value: string;
}

// ============================================================
// Utilities - All conversion logic lives here
// ============================================================

/**
 * InstantUtil - Utility for converting InstantDto to/from various formats.
 *
 * All methods are static - this is a pure utility class with no state.
 *
 * **Why UTC?** "It's recommended to convert all dates to UTC before storing.
 * Don't use local timezone. Otherwise, you'll be pulling your hair out when
 * your database is deployed in high availability designs across multiple data
 * centers across multiple timezones."
 * - Source: https://www.moesif.com/blog/technical/timestamp/manage-datetime-timestamp-timezones-in-api/
 */
export class InstantUtil {
    /**
     * Create InstantDto representing the current moment (UTC).
     */
    static now(): InstantDto {
        return { value: new Date().toISOString() };
    }

    /**
     * Create InstantDto from JavaScript Date object.
     */
    static fromDate(date: Date): InstantDto {
        return { value: date.toISOString() };
    }

    /**
     * Create InstantDto from ISO-8601 string.
     * @param iso - ISO-8601 string (e.g., "2024-12-03T14:30:00.000Z")
     */
    static fromString(iso: string): InstantDto {
        // Validate by parsing
        const date = new Date(iso);
        if (isNaN(date.getTime())) {
            throw new Error(`Invalid ISO-8601 string: ${iso}`);
        }
        return { value: date.toISOString() };
    }

    /**
     * Create InstantDto from epoch milliseconds.
     * @param millis - Milliseconds since Unix epoch (January 1, 1970, 00:00:00 UTC)
     */
    static fromEpochMillis(millis: number): InstantDto {
        return { value: new Date(millis).toISOString() };
    }

    /**
     * Convert InstantDto to JavaScript Date object.
     */
    static toDate(instant: InstantDto): Date {
        return new Date(instant.value);
    }

    /**
     * Get ISO-8601 string representation.
     */
    static toString(instant: InstantDto): string {
        return instant.value;
    }

    /**
     * Get epoch milliseconds (Unix timestamp).
     */
    static toEpochMillis(instant: InstantDto): number {
        return new Date(instant.value).getTime();
    }
}

/**
 * DateUtil - Utility for converting DateDto to/from various formats.
 *
 * All methods are static - this is a pure utility class with no state.
 *
 * **Note:** DateDto represents a date in the abstract sense, not tied to any timezone.
 * December 25th is Christmas regardless of what timezone you're in.
 */
export class DateUtil {
    /**
     * Create DateDto from year, month, day.
     * @param year - Full year (e.g., 2024)
     * @param month - Month (1-12, where 1 = January)
     * @param day - Day of month (1-31)
     */
    static of(year: number, month: number, day: number): DateDto {
        const monthStr = month.toString().padStart(2, '0');
        const dayStr = day.toString().padStart(2, '0');
        return { value: `${year}-${monthStr}-${dayStr}` };
    }

    /**
     * Create DateDto from JavaScript Date object.
     * Uses the local timezone's date.
     */
    static fromDate(date: Date): DateDto {
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        return { value: `${year}-${month}-${day}` };
    }

    /**
     * Create DateDto from ISO-8601 date string.
     * @param iso - ISO-8601 date string (e.g., "2024-12-03")
     */
    static fromString(iso: string): DateDto {
        // Validate format: YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
            throw new Error(`Invalid date format: ${iso}. Expected YYYY-MM-DD`);
        }
        return { value: iso };
    }

    /**
     * Convert DateDto to JavaScript Date object (at midnight local time).
     */
    static toDate(dateDto: DateDto): Date {
        return new Date(dateDto.value + 'T00:00:00');
    }

    /**
     * Get ISO-8601 date string.
     */
    static toString(dateDto: DateDto): string {
        return dateDto.value;
    }
}

/**
 * TimeUtil - Utility for converting TimeDto to/from various formats.
 *
 * All methods are static - this is a pure utility class with no state.
 */
export class TimeUtil {
    /**
     * Create TimeDto from hour, minute, second, and optional milliseconds.
     * @param hour - Hour (0-23)
     * @param minute - Minute (0-59)
     * @param second - Second (0-59)
     * @param millis - Milliseconds (0-999), optional
     */
    static of(hour: number, minute: number, second: number, millis?: number): TimeDto {
        const hourStr = hour.toString().padStart(2, '0');
        const minuteStr = minute.toString().padStart(2, '0');
        const secondStr = second.toString().padStart(2, '0');

        if (millis !== undefined) {
            const millisStr = millis.toString().padStart(3, '0');
            return { value: `${hourStr}:${minuteStr}:${secondStr}.${millisStr}` };
        }

        return { value: `${hourStr}:${minuteStr}:${secondStr}` };
    }

    /**
     * Create TimeDto from JavaScript Date object.
     * Uses the local timezone's time.
     * Includes milliseconds.
     */
    static fromDate(date: Date): TimeDto {
        const hour = date.getHours().toString().padStart(2, '0');
        const minute = date.getMinutes().toString().padStart(2, '0');
        const second = date.getSeconds().toString().padStart(2, '0');
        const millis = date.getMilliseconds().toString().padStart(3, '0');
        return { value: `${hour}:${minute}:${second}.${millis}` };
    }

    /**
     * Create TimeDto from ISO-8601 time string.
     * @param iso - ISO-8601 time string (e.g., "14:30:00" or "14:30:00.123")
     */
    static fromString(iso: string): TimeDto {
        // Validate format: HH:mm:ss or HH:mm:ss.SSS
        if (!/^\d{2}:\d{2}:\d{2}(\.\d{3})?$/.test(iso)) {
            throw new Error(`Invalid time format: ${iso}. Expected HH:mm:ss or HH:mm:ss.SSS`);
        }
        return { value: iso };
    }

    /**
     * Get ISO-8601 time string.
     */
    static toString(timeDto: TimeDto): string {
        return timeDto.value;
    }
}

/**
 * DateTimeUtil - Utility for converting DateTimeDto to/from various formats.
 *
 * All methods are static - this is a pure utility class with no state.
 *
 * **⚠️ WARNING:** Prefer InstantDto for most use cases to avoid timezone confusion!
 */
export class DateTimeUtil {
    /**
     * Create DateTimeDto from components.
     * @param year - Full year (e.g., 2024)
     * @param month - Month (1-12, where 1 = January)
     * @param day - Day of month (1-31)
     * @param hour - Hour (0-23)
     * @param minute - Minute (0-59)
     * @param second - Second (0-59)
     * @param millis - Milliseconds (0-999), optional
     */
    static of(
        year: number,
        month: number,
        day: number,
        hour: number,
        minute: number,
        second: number,
        millis?: number,
    ): DateTimeDto {
        const monthStr = month.toString().padStart(2, '0');
        const dayStr = day.toString().padStart(2, '0');
        const hourStr = hour.toString().padStart(2, '0');
        const minuteStr = minute.toString().padStart(2, '0');
        const secondStr = second.toString().padStart(2, '0');

        if (millis !== undefined) {
            const millisStr = millis.toString().padStart(3, '0');
            return {
                value: `${year}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:${secondStr}.${millisStr}`,
            };
        }

        return {
            value: `${year}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:${secondStr}`,
        };
    }

    /**
     * Create DateTimeDto from JavaScript Date object.
     * Uses the local timezone's date/time.
     * Includes milliseconds.
     */
    static fromDate(date: Date): DateTimeDto {
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const hour = date.getHours().toString().padStart(2, '0');
        const minute = date.getMinutes().toString().padStart(2, '0');
        const second = date.getSeconds().toString().padStart(2, '0');
        const millis = date.getMilliseconds().toString().padStart(3, '0');
        return { value: `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}` };
    }

    /**
     * Create DateTimeDto from ISO-8601 datetime string.
     * @param iso - ISO-8601 datetime string (e.g., "2024-12-03T14:30:00" or "2024-12-03T14:30:00.123")
     */
    static fromString(iso: string): DateTimeDto {
        // Validate format: YYYY-MM-DDTHH:mm:ss or YYYY-MM-DDTHH:mm:ss.SSS
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/.test(iso)) {
            throw new Error(
                `Invalid datetime format: ${iso}. Expected YYYY-MM-DDTHH:mm:ss or YYYY-MM-DDTHH:mm:ss.SSS`,
            );
        }
        return { value: iso };
    }

    /**
     * Convert DateTimeDto to JavaScript Date object (interprets as local timezone).
     */
    static toDate(dateTime: DateTimeDto): Date {
        return new Date(dateTime.value);
    }

    /**
     * Get ISO-8601 datetime string.
     */
    static toString(dateTime: DateTimeDto): string {
        return dateTime.value;
    }
}
