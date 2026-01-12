/**
 * Common utilities for messages V2.
 */

export function sleepMs(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
