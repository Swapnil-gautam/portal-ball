import { AIM_HALF_WIDTH, ARRIVAL_HEIGHT, STRIKE_Z } from "./court";
import { swingToShot } from "./gamestate";
import { Physics, planShot, type Paddle } from "./physics";

/**
 * The Paddle lab's ball feeder: sends a ball at you from the far end, lets
 * you hit it back, then sends the next one. No opponent, no score — just a
 * hit count, so you can feel how a paddle setting plays.
 */

const FEED_GAP_MS = 900;
const DEAD_BALL_MS = 1500;

export class BallMachine {
  readonly physics = new Physics();
  feeding = true;
  hits = 0;
  fed = 0;

  private state: "waiting" | "incoming" | "returned" = "waiting";
  private nextFeedAt = 0;

  /** Advance one frame. Returns true on the frame you hit the ball. */
  update(paddle: Paddle | null, dt: number, now: number): boolean {
    if (this.state === "waiting") {
      this.physics.hold({ x: 0, y: ARRIVAL_HEIGHT, z: STRIKE_Z.remote });
      if (this.feeding && now >= this.nextFeedAt) {
        // Vary the placement so you're not swinging at the same spot every time.
        const aimX = (Math.random() * 2 - 1) * AIM_HALF_WIDTH * 0.7;
        this.physics.launch(planShot(this.physics.ball.pos, "remote", { power: 0.25 + Math.random() * 0.3, aimX }), now);
        this.fed++;
        this.state = "incoming";
      }
      return false;
    }

    this.physics.update(dt);

    if (this.state === "incoming" && paddle && this.physics.canHit(paddle, "local")) {
      this.physics.launch(planShot(this.physics.ball.pos, "local", swingToShot(paddle)), now);
      this.hits++;
      this.state = "returned";
      return true;
    }

    const arrival = this.physics.ball.arrival;
    const dead = arrival !== null && now > arrival.at + DEAD_BALL_MS;
    if (this.physics.missedBy() || dead) {
      this.state = "waiting";
      this.nextFeedAt = now + FEED_GAP_MS;
    }
    return false;
  }

  reset(now: number): void {
    this.hits = 0;
    this.fed = 0;
    this.state = "waiting";
    this.nextFeedAt = now + FEED_GAP_MS;
  }
}
