/**
 * Detects Portal Ball running the camera in more than one browser tab.
 *
 * Every tab that has started the camera keeps running the hand tracker, even
 * in the background, and they compete for the same CPU and GPU — fewer frames
 * processed, so more lag and more dropouts on fast moves. That's easy to end
 * up with (opening the game again instead of switching back to its tab), and
 * hard to spot, so the game warns about it.
 *
 * Tabs talk over a BroadcastChannel: the tab you're looking at asks "who else
 * has the camera?" every few seconds, and any other tab with the camera
 * running answers at once. Timers in background tabs get heavily throttled,
 * but message handlers still run, so asking beats waiting for them to announce.
 */

const CHANNEL = "portal-ball-camera";
const ASK_EVERY_MS = 2500;
/** An answer older than this means that tab has gone. */
const FORGET_AFTER_MS = 6000;

type Message = { type: "ask" | "here" | "bye"; id: string };

const id = Math.random().toString(36).slice(2);
const channel: BroadcastChannel | null = "BroadcastChannel" in globalThis ? new BroadcastChannel(CHANNEL) : null;
/** Other tabs with the camera running, and when (on our clock) we last heard from them. */
const others = new Map<string, number>();
let cameraOn = false;

channel?.addEventListener("message", (e: MessageEvent<Message>) => {
  const msg = e.data;
  if (!msg || msg.id === id) return;
  if (msg.type === "ask" && cameraOn) channel.postMessage({ type: "here", id } satisfies Message);
  else if (msg.type === "here") others.set(msg.id, performance.now());
  else if (msg.type === "bye") others.delete(msg.id);
});

window.addEventListener("pagehide", () => {
  if (cameraOn) channel?.postMessage({ type: "bye", id } satisfies Message);
});

/** Call once the camera is running in this tab. */
export function announceCamera(): void {
  if (cameraOn || !channel) return;
  cameraOn = true;
  const ask = () => {
    if (document.visibilityState === "visible") channel.postMessage({ type: "ask", id } satisfies Message);
  };
  ask();
  window.setInterval(ask, ASK_EVERY_MS);
}

/** How many other tabs are running the Portal Ball camera right now. */
export function otherCameraTabs(): number {
  const now = performance.now();
  for (const [k, at] of others) if (now - at > FORGET_AFTER_MS) others.delete(k);
  return others.size;
}
