import {
  AIM_HALF_WIDTH,
  ARRIVAL_HEIGHT,
  BALL_RADIUS,
  CAMERA_POS,
  COURT_LENGTH,
  DEFAULT_RESTITUTION,
  FLOOR_Y,
  GRAVITY,
  CONTACT_EARLY_S,
  CONTACT_LATE_S,
  CONTACT_RADIUS,
  NET_HEIGHT,
  OUT_MARGIN,
  STRIKE_Z,
} from "./court";

/**
 * Ball physics, in the world units defined in court.ts.
 *
 * Every shot is *planned*: given how hard and where you swung, planShot()
 * works out a launch that clears the net, bounces once on the receiver's
 * half (≈68% of the way there), and comes up to a hittable height exactly as
 * it reaches their strike plane. The ball then flies under plain gravity —
 * the plan only chooses the launch velocity and how lively that one bounce
 * is. That's what makes a rally read like tennis: the ball arrives where the
 * other player can actually meet it, every time, instead of wherever an
 * unguided launch happened to send it.
 */

export type Side = "local" | "remote";

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Ball {
  pos: Vector3;
  vel: Vector3;
  /** Restitution for the next floor contact only — set per shot so it lands as planned. */
  nextRestitution: number;
  /** True until the planned bounce happens; later bounces (after a miss) also lose speed. */
  plannedBounce: boolean;
  /** Where and when the current shot reaches the receiver's strike plane (local clock). */
  arrival: { x: number; y: number; at: number } | null;
  /** False while the ball is being held for a serve. */
  inPlay: boolean;
}

/** A paddle on its own strike plane: position and velocity in world units. */
export interface Paddle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** What a hitter intends: 0..1 power, and where across the court to send it. */
export interface ShotInput {
  power: number;
  aimX: number;
  aimHeight?: number;
}

/** A fully planned shot — also the wire format for sending it to the other player. */
export interface Shot {
  pos: Vector3;
  vel: Vector3;
  restitution: number;
  flightS: number;
  arrival: { x: number; y: number };
}

const BOUNCE_FRACTION = 0.68;
const SLOWEST_FLIGHT_S = 1.5;
const FASTEST_FLIGHT_S = 0.95;
const SUBSTEP_S = 1 / 240;
const REST_SPEED = 0.4; // below this, a bounce settles instead of buzzing
const ROLL_FRICTION = 0.9; // per unplanned bounce / per second while rolling

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function planShot(from: Vector3, hitter: Side, input: ShotInput): Shot {
  const fastest = SLOWEST_FLIGHT_S - (SLOWEST_FLIGHT_S - FASTEST_FLIGHT_S) * clamp(input.power, 0, 1);
  // A hard swing from very low can't both stay fast and clear the net — so
  // give it just enough extra air time. It still feels like the hardest shot
  // available from down there, it just doesn't pass through the net.
  for (let T = fastest; T < SLOWEST_FLIGHT_S + 0.4; T += 0.05) {
    const shot = shotWithFlightTime(from, hitter, input, T);
    if (netClearance(shot) >= NET_MARGIN) return shot;
  }
  return shotWithFlightTime(from, hitter, input, SLOWEST_FLIGHT_S + 0.4);
}

const NET_MARGIN = 0.1;

/** Height of the ball's underside above the net tape as it crosses mid-court. */
function netClearance(shot: Shot): number {
  const t = (COURT_LENGTH / 2 - shot.pos.z) / shot.vel.z;
  const y = shot.pos.y + shot.vel.y * t - 0.5 * GRAVITY * t * t;
  return y - BALL_RADIUS - NET_HEIGHT;
}

function shotWithFlightTime(from: Vector3, hitter: Side, input: ShotInput, T: number): Shot {
  const targetZ = hitter === "local" ? STRIKE_Z.remote : STRIKE_Z.local;
  const t1 = BOUNCE_FRACTION * T; // until the bounce
  const t2 = T - t1; // bounce to strike plane

  const y0 = Math.max(FLOOR_Y + 0.05, from.y);
  const wantY = clamp(input.aimHeight ?? ARRIVAL_HEIGHT, 0.8, 1.9);

  // Launch so the ball meets the floor exactly at t1…
  const vy0 = (0.5 * GRAVITY * t1 * t1 - (y0 - FLOOR_Y)) / t1;
  const impact = Math.abs(vy0 - GRAVITY * t1);
  // …then pick that bounce's liveliness so it rises to wantY by T. Clamped to
  // a believable range; hard, low shots come in a bit lower, like flat shots do.
  const needed = (wantY - FLOOR_Y + 0.5 * GRAVITY * t2 * t2) / t2;
  const restitution = clamp(needed / impact, 0.6, 0.95);
  const vb = impact * restitution;
  const arrivalY = Math.max(FLOOR_Y, FLOOR_Y + vb * t2 - 0.5 * GRAVITY * t2 * t2);

  const aimX = clamp(input.aimX, -AIM_HALF_WIDTH, AIM_HALF_WIDTH);

  return {
    pos: { x: from.x, y: y0, z: from.z },
    vel: { x: (aimX - from.x) / T, y: vy0, z: (targetZ - from.z) / T },
    restitution,
    flightS: T,
    arrival: { x: aimX, y: arrivalY },
  };
}

export class Physics {
  /**
   * Contact radius for the local player's paddle — follows the paddle size
   * setting. The remote side (AI or the other player's own machine) keeps
   * the default.
   */
  localContactRadius = CONTACT_RADIUS;

  ball: Ball = {
    pos: { x: 0, y: ARRIVAL_HEIGHT, z: STRIKE_Z.local },
    vel: { x: 0, y: 0, z: 0 },
    nextRestitution: DEFAULT_RESTITUTION,
    plannedBounce: false,
    arrival: null,
    inPlay: false,
  };

  /** Hold the ball still at `pos` (serving). Physics doesn't touch it until launched. */
  hold(pos: Vector3): void {
    this.ball = {
      pos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      nextRestitution: DEFAULT_RESTITUTION,
      plannedBounce: false,
      arrival: null,
      inPlay: false,
    };
  }

  /** Put a planned shot in flight. `launchedAt` is when it left the paddle, on the local clock. */
  launch(shot: Shot, launchedAt: number): void {
    this.ball = {
      pos: { ...shot.pos },
      vel: { ...shot.vel },
      nextRestitution: shot.restitution,
      plannedBounce: true,
      arrival: { ...shot.arrival, at: launchedAt + shot.flightS * 1000 },
      inPlay: true,
    };
  }

  /** Advance `dt` seconds in fixed substeps, so bounces land where the plan says regardless of frame rate. */
  update(dt: number): void {
    if (!this.ball.inPlay) return;
    let remaining = dt;
    while (remaining > 1e-9) {
      const h = Math.min(SUBSTEP_S, remaining);
      this.substep(h);
      remaining -= h;
    }
  }

  private substep(h: number): void {
    const b = this.ball;
    const resting = b.pos.y <= FLOOR_Y + 1e-6 && b.vel.y === 0;

    if (resting) {
      // Rolling: no gravity (the floor holds it), just friction.
      const f = Math.pow(ROLL_FRICTION, h);
      b.vel.x *= f;
      b.vel.z *= f;
    } else {
      b.vel.y -= GRAVITY * h;
    }

    b.pos.x += b.vel.x * h;
    b.pos.y += b.vel.y * h;
    b.pos.z += b.vel.z * h;

    if (b.pos.y < FLOOR_Y) {
      const planned = b.plannedBounce;
      const e = b.nextRestitution;
      b.nextRestitution = DEFAULT_RESTITUTION;
      b.plannedBounce = false;

      b.pos.y = FLOOR_Y + (FLOOR_Y - b.pos.y) * e;
      b.vel.y = -b.vel.y * e;

      if (!planned) {
        b.vel.x *= ROLL_FRICTION;
        b.vel.z *= ROLL_FRICTION;
      }
      // The old version flipped velocity forever with no resting state, so a
      // ball on the floor re-bounced every frame — the vibration you saw.
      if (Math.abs(b.vel.y) < REST_SPEED) {
        b.vel.y = 0;
        b.pos.y = FLOOR_Y;
      }
    }
  }

  /**
   * Is the ball heading toward `side` and reaching its paddle right now?
   * Measured in time-to-plane, so the leeway is the same for fast and slow shots.
   */
  inStrikeWindow(side: Side): boolean {
    const b = this.ball;
    if (!b.inPlay) return false;
    const closing = side === "local" ? -b.vel.z : b.vel.z; // speed toward that paddle
    if (closing <= 0) return false;
    const timeToPlane = (side === "local" ? b.pos.z - STRIKE_Z.local : STRIKE_Z.remote - b.pos.z) / closing;
    return timeToPlane <= CONTACT_EARLY_S && timeToPlane >= -CONTACT_LATE_S;
  }

  /**
   * Where the ball appears to be from the local camera, projected onto the
   * local strike plane. The paddle lives on that plane, so comparing the two
   * is "does the paddle cover the ball on screen" — what the player is
   * actually trying to do — even when the ball is a little in front of or
   * behind the plane.
   */
  apparentOnLocalPlane(): { x: number; y: number } {
    const p = this.ball.pos;
    const c = CAMERA_POS;
    const t = (STRIKE_Z.local - c.z) / Math.max(1e-3, p.z - c.z);
    return { x: c.x + t * (p.x - c.x), y: c.y + t * (p.y - c.y) };
  }

  /**
   * Can `paddle` hit the ball right now? The local player is tested in
   * screen terms (see apparentOnLocalPlane); the AI has no screen, so it's
   * tested directly in world space at its own plane.
   */
  canHit(paddle: Paddle, side: Side): boolean {
    if (!this.inStrikeWindow(side)) return false;
    const q = side === "local" ? this.apparentOnLocalPlane() : this.ball.pos;
    const radius = side === "local" ? this.localContactRadius : CONTACT_RADIUS;
    return Math.hypot(q.x - paddle.x, q.y - paddle.y) <= radius;
  }

  /** Which side let the ball get past them, if any. */
  missedBy(): Side | null {
    const z = this.ball.pos.z;
    if (z < STRIKE_Z.local - OUT_MARGIN) return "local";
    if (z > STRIKE_Z.remote + OUT_MARGIN) return "remote";
    return null;
  }
}
