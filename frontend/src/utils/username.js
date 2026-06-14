/**
 * Login account-name validation utilities
 *
 * Requirements:
 * - 3-32 characters long
 * - Can contain letters, digits, underscores, and hyphens
 */

export const USERNAME_REGEX = /^[A-Za-z0-9_-]+$/;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * HTML5 pattern attribute for username inputs (without ^ and $)
 */
export const USERNAME_PATTERN = "[A-Za-z0-9_-]+";
