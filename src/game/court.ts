/**
 * The court's geometry, in world units, shared by physics, rendering and hit
 * testing. Earlier versions kept a separate normalized space for physics and
 * scaled it for rendering, which let the two drift apart — the paddle was
 * drawn at one depth and hit-tested at another, so lining it up on screen
 * didn't line it up in the physics. One set of numbers, used everywhere.
 *
 *   x — lateral (camera's view: +x is screen-left, since it looks down +z)
 *   y — height above the floor
 *   z — depth: your end near 0, the opponent's end near COURT_LENGTH
 */

import type { Side } from "./physics";

export const COURT_LENGTH = 10;
export const HALF_WIDTH = 2.4;
export const NET_HEIGHT = 0.55;

export const BALL_RADIUS = 0.12;
export const FLOOR_Y = BALL_RADIUS; // ball centre when resting on the floor

/**
 * Where each player's paddle lives, and where incoming shots are aimed.
 * Depth can't be sensed from one webcam, so this is a fixed plane — a hit is
 * "paddle covers the ball on screen, while the ball is crossing this plane".
 */
export const STRIKE_Z: Record<Side, number> = { local: 1.2, remote: COURT_LENGTH - 1.2 };

/** How far past the strike plane a missed ball travels before the point ends. */
export const OUT_MARGIN = 1.6;

export const CAMERA_POS = { x: 0, y: 1.55, z: -1.3 };
export const CAMERA_LOOK = { x: 0, y: 0.95, z: COURT_LENGTH * 0.55 };
export const CAMERA_FOV = 56;

export const GRAVITY = 12;
/** Restitution for bounces that aren't part of a planned shot (e.g. after a miss). */
export const DEFAULT_RESTITUTION = 0.7;

/** The paddle: a round head on a handle. Your hand holds the handle; the head hits the ball. */
export const HEAD_RADIUS = 0.3;
export const HEAD_THICKNESS = 0.035;
export const HANDLE_LENGTH = 0.28;
/** From your palm (where the handle is held) to the centre of the head. */
export const HEAD_OFFSET = HEAD_RADIUS + HANDLE_LENGTH * 0.55;

/**
 * Contact: the ball's centre must be over the paddle face — not merely its
 * edge touching the rim, which is what the first version counted and why
 * hits looked like they happened at the boundary.
 */
export const CONTACT_RADIUS = HEAD_RADIUS + BALL_RADIUS * 0.25;
/**
 * …and at the moment the ball actually reaches the paddle. A little leeway
 * either side absorbs hand-tracking latency, but it no longer connects while
 * the ball is still visibly in front of the paddle (the old ±160ms window).
 */
export const CONTACT_EARLY_S = 0.03;
export const CONTACT_LATE_S = 0.09;

/** Comfortable contact height — shots are aimed to arrive here. */
export const ARRIVAL_HEIGHT = 1.3;
/** Keep aimed shots where the receiver can actually see and reach them. */
export const AIM_HALF_WIDTH = 1.8;
