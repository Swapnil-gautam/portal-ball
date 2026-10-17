/**
 * Notices when a newer version of the site has been published.
 *
 * Browsers (and GitHub Pages' cache) can keep serving a page for a while
 * after a deploy, and an open tab never updates itself — so two players can
 * end up on different versions without knowing. The build writes a tiny
 * version file; this fetches it past every cache and compares.
 */

export interface UpdateCheckOptions {
  /** This page's build id (baked in at build time). */
  currentBuild: string;
  /** Where the build writes its version file. */
  url: string;
  /** How often to look again. */
  everyMs: number;
  /** Called once, the first time a different build is found. */
  onUpdate: (build: string) => void;
}

/** Starts watching. Resolves when the first check is done. */
export function watchForUpdates(o: UpdateCheckOptions): Promise<void> {
  let found = false;
  const check = async () => {
    if (found) return;
    try {
      // The query string gets past the CDN's cache; no-store past the browser's.
      const res = await fetch(`${o.url}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const { build } = (await res.json()) as { build?: string };
      if (build && build !== o.currentBuild) {
        found = true;
        o.onUpdate(build);
      }
    } catch {
      // Offline or blocked: try again next time.
    }
  };
  const first = check();
  window.setInterval(check, o.everyMs);
  // Also check when the player comes back to the tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  return first;
}
