import { AIM_HALF_WIDTH, ARRIVAL_HEIGHT } from "./court";
import type { Ball, Paddle, ShotInput } from "./physics";

/**
 * A bot that plays the remote side through the same rules as a person.
 *
 * Every shot carries its planned arrival point, so the bot reads where the
 * ball will cross its strike plane — then misjudges it by an amount that
 * shrinks with difficulty, reacts after a delay, and moves at a capped
 * speed. Misses come from those three human-ish limits, not from dice.
 */
export class AIOpponent {
  paddle: Paddle = { x: 0, y: ARRIVAL_HEIGHT, vx: 0, vy: 0 };
  /** What it will do with the ball when it connects. GameState reads this. */
  intent: ShotInput = { power: 0.35, aimX: 0 };

  private target = { x: 0, y: ARRIVAL_HEIGHT };
  private readingFor: number | null = null; // arrival.at of the shot currently being read
  private readyAt = 0;

  /** 0 (easy) .. 1 (hard). */
  constructor(public readonly difficulty = 0.5) {}

  update(ball: Ball, opponent: Paddle | null, dt: number, now: number): void {
    const d = this.difficulty;
    const incoming = ball.inPlay && ball.vel.z > 0 && ball.arrival;

    if (incoming && ball.arrival && this.readingFor !== ball.arrival.at) {
      // A new shot is on its way: commit to a read of it, with error.
      this.readingFor = ball.arrival.at;
      this.readyAt = now + (320 - d * 220); // reaction delay, 100–320ms
      // Difficulty sets how often it misjudges a shot: about half the time at
      // 0%, about 1 in 20 at 100%. A misjudged ball still plays out on screen
      // — it commits to the wrong spot, the way a person does. (A plain random
      // read error made difficulty a cliff: 25% was easy, 50% almost never missed.)
      const misjudged = Math.random() > 0.55 + 0.4 * d;
      const offX = misjudged ? (0.65 + Math.random() * 0.45) * (Math.random() < 0.5 ? -1 : 1) : (Math.random() * 2 - 1) * 0.2;
      this.target = {
        x: ball.arrival.x + offX,
        y: ball.arrival.y + (Math.random() * 2 - 1) * 0.12,
      };
      this.intent = this.chooseShot(opponent);
    } else if (!ball.inPlay) {
      // Serving or between points: wait in the middle, under the ball.
      this.target = { x: ball.pos.x, y: ARRIVAL_HEIGHT };
      this.readyAt = now;
    }

    const prevX = this.paddle.x;
    const prevY = this.paddle.y;
    if (now >= this.readyAt) {
      const maxStep = (2.5 + 4.5 * d) * dt; // world units/s
      this.paddle.x = approach(this.paddle.x, this.target.x, maxStep);
      this.paddle.y = approach(this.paddle.y, this.target.y, maxStep);
    }
    this.paddle.vx = dt > 0 ? (this.paddle.x - prevX) / dt : 0;
    this.paddle.vy = dt > 0 ? (this.paddle.y - prevY) / dt : 0;
  }

  /** Harder bots hit harder and aim away from where you're standing. */
  private chooseShot(opponent: Paddle | null): ShotInput {
    const d = this.difficulty;
    const power = Math.min(1, 0.2 + d * 0.55 + Math.random() * 0.2);

    let aimX = (Math.random() * 2 - 1) * AIM_HALF_WIDTH * 0.8;
    if (opponent && Math.random() < d) {
      // Aim to the side the player isn't on. Solo play shares one world, so
      // no mirroring — just the opposite sign of where their paddle is.
      const away = opponent.x > 0 ? -1 : 1;
      aimX = away * (0.6 + Math.random() * 1.1);
    }
    return { power, aimX };
  }
}

function approach(current: number, target: number, maxStep: number): number {
  const delta = target - current;
  return Math.abs(delta) <= maxStep ? target : current + Math.sign(delta) * maxStep;
}
