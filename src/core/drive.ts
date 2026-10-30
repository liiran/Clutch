// A toy car for the landing page: simple arcade physics with no browser code. It drives
// on the plate, climbs ramps, jumps off them, lands, and bounces off everything else.
// Nothing can break, and it cannot leave the plate.

// A solid thing, from height y0 up to h. The car can land on a low one and drive under a high one.
export interface Box { x0: number; x1: number; z0: number; z1: number; y0: number; h: number }

// A wedge that rises to height h toward `rise`, the direction it launches the car.
export interface Ramp { x0: number; x1: number; z0: number; z1: number; h: number; rise: 'x+' | 'x-' | 'z+' | 'z-' }

export interface World { boxes: Box[]; ramps: Ramp[]; bound: number }

export interface Car {
  x: number; y: number; z: number
  heading: number // radians; 0 faces +z
  vx: number; vy: number; vz: number
  grounded: boolean
}

export interface Input { throttle: number; steer: number }

export const CAR_RADIUS = 1.5
export const CAR_HEIGHT = 2.2
const ACCEL = 30, BRAKE = 44, TOP_SPEED = 21, REVERSE_SPEED = 9
const DRAG = 1.3, GRIP = 9, TURN = 2.9, GRAVITY = 30
const STEP_UP = 0.45, STICK = 0.16, BOUNCE = 0.6, LAND_BOUNCE = 0.32
const MAX_STEP = 1 / 120

export function newCar(x: number, z: number, heading: number, y = 0): Car {
  return { x, y, z, heading, vx: 0, vy: 0, vz: 0, grounded: y === 0 }
}

export const speedOf = (car: Car) => Math.hypot(car.vx, car.vz)

export function isResting(car: Car) {
  return car.grounded && speedOf(car) < 0.04 && Math.abs(car.vy) < 0.01
}

function rampHeight(ramp: Ramp, x: number, z: number): number | null {
  if (x < ramp.x0 || x > ramp.x1 || z < ramp.z0 || z > ramp.z1) return null
  const along = ramp.rise === 'x+' ? (x - ramp.x0) / (ramp.x1 - ramp.x0)
    : ramp.rise === 'x-' ? (ramp.x1 - x) / (ramp.x1 - ramp.x0)
    : ramp.rise === 'z+' ? (z - ramp.z0) / (ramp.z1 - ramp.z0)
    : (ramp.z1 - z) / (ramp.z1 - ramp.z0)
  return ramp.h * along
}

// The height of the surface under this spot, for a car coming down from `y`.
export function floorAt(world: World, x: number, z: number, y: number): number {
  let floor = 0
  for (const ramp of world.ramps) {
    const h = rampHeight(ramp, x, z)
    if (h !== null && h > floor) floor = h
  }
  for (const box of world.boxes) {
    if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1 && box.h > floor && y + STEP_UP >= box.h) floor = box.h
  }
  return floor
}

// Pushes the car out of a box it has run into, and bounces it off. Returns how hard it hit.
function collide(car: Car, box: Box): number {
  // It clears it above, or passes under it.
  if (car.y + STEP_UP >= box.h || car.y + CAR_HEIGHT <= box.y0) return 0
  const nearX = Math.max(box.x0, Math.min(car.x, box.x1))
  const nearZ = Math.max(box.z0, Math.min(car.z, box.z1))
  let dx = car.x - nearX, dz = car.z - nearZ
  let dist = Math.hypot(dx, dz)
  if (dist >= CAR_RADIUS) return 0
  if (dist < 1e-6) {
    // Its centre is inside: leave by the nearest side.
    const exits: Array<[number, number, number]> = [
      [car.x - box.x0, -1, 0], [box.x1 - car.x, 1, 0], [car.z - box.z0, 0, -1], [box.z1 - car.z, 0, 1],
    ]
    exits.sort((a, b) => a[0] - b[0])
    dx = exits[0][1]; dz = exits[0][2]; dist = 1
    car.x += dx * exits[0][0]
    car.z += dz * exits[0][0]
    return bounceOff(car, box, dx, dz)
  }
  return bounceOff(car, box, dx / dist, dz / dist, CAR_RADIUS - dist)
}

function bounceOff(car: Car, _box: Box, nx: number, nz: number, push = CAR_RADIUS): number {
  car.x += nx * push
  car.z += nz * push
  const into = car.vx * nx + car.vz * nz
  if (into >= 0) return 0
  car.vx -= (1 + BOUNCE) * into * nx
  car.vz -= (1 + BOUNCE) * into * nz
  return -into
}

// Moves the car on by `seconds`. Returns the hardest hit, 0 if it hit nothing.
export function stepCar(car: Car, input: Input, world: World, seconds: number): number {
  let hit = 0
  const steps = Math.max(1, Math.ceil(Math.min(seconds, 0.1) / MAX_STEP))
  const dt = Math.min(seconds, 0.1) / steps
  for (let i = 0; i < steps; i++) hit = Math.max(hit, tick(car, input, world, dt))
  return hit
}

function tick(car: Car, input: Input, world: World, dt: number): number {
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading)
  let forward = car.vx * fx + car.vz * fz
  let side = car.vx * fz - car.vz * fx

  if (car.grounded) {
    // Steering follows the way the car is rolling, and needs it to be rolling.
    const roll = Math.min(1, Math.abs(forward) / 6)
    car.heading += input.steer * TURN * roll * Math.sign(forward || 1) * dt
    if (input.throttle > 0) forward += (forward < 0 ? BRAKE : ACCEL) * dt
    else if (input.throttle < 0) forward -= (forward > 0 ? BRAKE : ACCEL) * dt
    forward *= Math.exp(-DRAG * dt)
    side *= Math.exp(-GRIP * dt)
    forward = Math.max(-REVERSE_SPEED, Math.min(TOP_SPEED, forward))
    if (!input.throttle && Math.abs(forward) < 0.15) forward = 0
    const nfx = Math.sin(car.heading), nfz = Math.cos(car.heading)
    car.vx = nfx * forward + nfz * side
    car.vz = nfz * forward - nfx * side
  }

  const px = car.x, pz = car.z
  car.x += car.vx * dt
  car.z += car.vz * dt

  // Bouncing off everything solid, and the edge of the plate.
  let hit = 0
  for (const box of world.boxes) hit = Math.max(hit, collide(car, box))
  const limit = world.bound
  if (Math.abs(car.x) > limit) {
    car.x = Math.sign(car.x) * limit
    hit = Math.max(hit, Math.abs(car.vx))
    car.vx *= -BOUNCE
  }
  if (Math.abs(car.z) > limit) {
    car.z = Math.sign(car.z) * limit
    hit = Math.max(hit, Math.abs(car.vz))
    car.vz *= -BOUNCE
  }

  // The tall end or side of a ramp is a wall when coming from below it.
  let floor = floorAt(world, car.x, car.z, car.y)
  if (floor - car.y > STEP_UP) {
    hit = Math.max(hit, speedOf(car))
    car.x = px
    car.z = pz
    car.vx *= -BOUNCE
    car.vz *= -BOUNCE
    floor = floorAt(world, car.x, car.z, car.y)
  }

  if (car.grounded) {
    if (floor > car.y || car.y - floor < STICK) {
      // Climbing gives upward speed, which is what launches it off the top.
      const climbed = floor - car.y
      car.vy = dt > 0 ? climbed / dt : 0
      car.y = floor
    } else {
      car.grounded = false // it ran off the top of something
    }
  }
  if (!car.grounded) {
    car.vy -= GRAVITY * dt
    car.y += car.vy * dt
    if (car.y <= floor) {
      car.y = floor
      if (car.vy < -5) {
        hit = Math.max(hit, -car.vy * 0.6)
        car.vy = -car.vy * LAND_BOUNCE
      } else {
        car.vy = 0
        car.grounded = true
      }
    }
  }
  return hit
}
