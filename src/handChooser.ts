/**
 * Decides which detected hand is the player's paddle hand.
 *
 * MediaPipe labels hands "Left"/"Right", but its labels assume a particular
 * mirroring of the camera image — and webcams differ: some drivers deliver a
 * mirrored picture, some don't. An earlier version trusted one convention and
 * filtered by label, so on a camera with the other convention it threw the
 * player's hand away and nothing was detected at all.
 *
 * So the label is only a tiebreaker:
 *   - one hand in view → use it, whatever it's called;
 *   - two hands → stay with the hand you've been playing with (nearest to
 *     where the paddle hand just was);
 *   - two hands and no recent position → the label your playing hand usually
 *     gets on *this* camera, learned from frames where it was alone.
 */

export type HandLabel = "Left" | "Right";

export interface HandCandidate {
  /** Index into MediaPipe's result arrays. */
  i: number;
  label: HandLabel | null;
  score: number;
  /** Palm centre, normalized image coordinates (any consistent space). */
  palm: { x: number; y: number };
}

/** How long a last-seen position stays useful for telling two hands apart. */
const STICK_MS = 700;
/** The starting guess counts this many frames' worth of evidence, so real play quickly outweighs it. */
const PRIOR_WEIGHT = 5;
const MAX_VOTES = 600;

export class HandChooser {
  private last: { x: number; y: number; t: number } | null = null;
  private votes: Record<HandLabel, number> = { Left: 0, Right: 0 };

  /**
   * `guess` is the label MediaPipe is expected to give the player's paddle
   * hand before there's any evidence (for a right hand on an unmirrored
   * webcam, that's "Left").
   */
  constructor(guess: HandLabel) {
    this.votes[guess] = PRIOR_WEIGHT;
  }

  /** The label the player's hand gets on this camera, as far as we can tell. */
  get playingLabel(): HandLabel {
    return this.votes.Left >= this.votes.Right ? "Left" : "Right";
  }

  choose(hands: HandCandidate[], t: number): HandCandidate | null {
    if (hands.length === 0) return null;

    let pick: HandCandidate;
    if (hands.length === 1) {
      pick = hands[0];
      if (pick.label) this.vote(pick.label);
    } else if (this.last && t - this.last.t < STICK_MS) {
      const last = this.last;
      pick = hands.reduce((a, b) => (dist(a.palm, last) <= dist(b.palm, last) ? a : b));
    } else {
      const want = this.playingLabel;
      pick = hands.find((h) => h.label === want) ?? hands.reduce((a, b) => (a.score >= b.score ? a : b));
    }

    this.last = { x: pick.palm.x, y: pick.palm.y, t };
    return pick;
  }

  private vote(label: HandLabel): void {
    this.votes[label]++;
    if (this.votes.Left + this.votes.Right > MAX_VOTES) {
      this.votes.Left /= 2;
      this.votes.Right /= 2;
    }
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
