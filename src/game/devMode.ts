/**
 * Developer tools (the Paddle lab and its saved tuning) — off for players.
 *
 * Open the game with `?dev` in the address to switch them on; it's
 * remembered in this browser until you open it with `?dev=0`.
 */

const STORAGE_KEY = "portalBall.dev";

function readDevMode(): boolean {
  try {
    const param = new URLSearchParams(globalThis.location?.search ?? "").get("dev");
    const storage = globalThis.localStorage;
    if (param === "0") storage?.removeItem(STORAGE_KEY);
    else if (param !== null) storage?.setItem(STORAGE_KEY, "1");
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // storage blocked: the URL alone can't be remembered, so stay a player
  }
}

export const devMode = readDevMode();
