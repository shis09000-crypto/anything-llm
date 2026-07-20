const VALID_PROTOCOLS = ["https:", "http:"];
const { isLiteralDestinationAllowed } = require("../networkGuard");

/**
 * Validates a URL strictly
 * - Checks the URL forms a valid URL
 * - Checks the URL is at least HTTP(S)
 * - Rejects private destinations unless they are explicitly allowlisted
 * @param {string} url
 * @returns {boolean}
 */
function validURL(url) {
  try {
    const destination = new URL(url);
    if (!VALID_PROTOCOLS.includes(destination.protocol)) return false;
    if (!isLiteralDestinationAllowed(destination.hostname)) return false;
    return true;
  } catch {}
  return false;
}

/**
 * Modifies a URL to be valid:
 * - Checks the URL is at least HTTP(S) so that protocol exists
 * - Checks the URL forms a valid URL
 * @param {string} url
 * @returns {string}
 */
function validateURL(url) {
  try {
    let destination = url.trim();
    // If the URL has a protocol, just pass through
    // If the URL doesn't have a protocol, assume https://
    if (destination.includes("://"))
      destination = new URL(destination).toString();
    else destination = new URL(`https://${destination}`).toString();

    // If the URL ends with a slash, remove it
    return destination.endsWith("/") ? destination.slice(0, -1) : destination;
  } catch {
    if (typeof url !== "string") return "";
    return url.trim();
  }
}

/**
 * Validate if a link is a valid YouTube video URL
 * - Checks youtu.be, youtube.com, m.youtube.com, music.youtube.com
 * - Embed video URLs
 * - Short URLs
 * - Live URLs
 * - Regular watch URLs
 * - Optional query parameters (including ?v parameter)
 *
 * Can be used to extract the video ID from a YouTube video URL via the returnVideoId parameter.
 * @param {string} link - The link to validate
 * @param {boolean} returnVideoId - Whether to return the video ID if the link is a valid YouTube video URL
 * @returns {boolean|string} - Whether the link is a valid YouTube video URL or the video ID if returnVideoId is true
 */
function validYoutubeVideoUrl(link, returnVideoId = false) {
  try {
    if (!link || typeof link !== "string") return false;
    let urlToValidate = link;

    if (!link.startsWith("http://") && !link.startsWith("https://")) {
      urlToValidate = "https://" + link;
      urlToValidate = new URL(urlToValidate).toString();
    }

    const regex =
      /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?(?:.*&)?v=|(?:live\/)?|shorts\/))([\w-]{11})(?:\S+)?$/;
    const match = urlToValidate.match(regex);
    if (returnVideoId) return match?.[1] ?? null;
    return !!match?.[1];
  } catch (error) {
    console.error("Error validating YouTube video URL", error);
    return returnVideoId ? null : false;
  }
}

module.exports = {
  validURL,
  validateURL,
  validYoutubeVideoUrl,
};
