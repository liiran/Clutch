// Generates every 3D model from the catalogue. All models are built around the
// centre of their footprint at rot 0, with y = 0 at the bottom, and share these
// real proportions: a stud pitch is 1 unit and a plate is 0.4 tall.

import * as THREE from 'three'
import { PART, type PartDef } from '../core/parts.ts'
import { MAX_LEVEL, STARTING_LEVEL } from './quality.ts'

export const PLATE_H = 0.4
const GAP = 0.012      // the small gap between neighbouring pieces, which draws the seams
const STUD_R = 0.3
const STUD_H = 0.2
const LOW = STARTING_LEVEL >= MAX_LEVEL - 1
const STUD_SEGMENTS = LOW ? 6 : 10
const ROUND = LOW ? 0.7 : 1 // scales the sides on round parts
const sides = (count: number) => Math.max(6, Math.round(count * ROUND))

type V3 = [number, number, number]

// A sub-part is one material on one piece: the body takes the piece's colour, and a
// fixed sub-part keeps its own (a tyre stays black, a window pane stays glass).
export interface Sub {
  geometry: THREE.BufferGeometry
  fixed?: number
  glass?: boolean
}

class Builder {
  private pos: number[] = []
  private nor: number[] = []

  private push(p: V3, n: V3) {
    this.pos.push(p[0], p[1], p[2])
    this.nor.push(n[0], n[1], n[2])
  }

  // A flat triangle, wound to face away from `inside`.
  flat(a: V3, b: V3, c: V3, inside: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-9) return
    nx /= len; ny /= len; nz /= len
    const out = nx * (a[0] - inside[0]) + ny * (a[1] - inside[1]) + nz * (a[2] - inside[2])
    if (out >= 0) {
      this.push(a, [nx, ny, nz]); this.push(b, [nx, ny, nz]); this.push(c, [nx, ny, nz])
    } else {
      this.push(a, [-nx, -ny, -nz]); this.push(c, [-nx, -ny, -nz]); this.push(b, [-nx, -ny, -nz])
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, inside: V3) {
    this.flat(a, b, c, inside)
    this.flat(a, c, d, inside)
  }

  // A box with chamfered edges, which catch the light the way moulded plastic does.
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c = 0.035) {
    const inside: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
    const X = (s: number) => s ? x1 : x0, Y = (s: number) => s ? y1 : y0, Z = (s: number) => s ? z1 : z0
    const iX = (s: number) => s ? x1 - c : x0 + c, iY = (s: number) => s ? y1 - c : y0 + c, iZ = (s: number) => s ? z1 - c : z0 + c
    const px = (a: number, b: number, d: number): V3 => [X(a), iY(b), iZ(d)]
    const py = (a: number, b: number, d: number): V3 => [iX(a), Y(b), iZ(d)]
    const pz = (a: number, b: number, d: number): V3 => [iX(a), iY(b), Z(d)]
    for (const s of [0, 1]) {
      this.quad(px(s, 0, 0), px(s, 1, 0), px(s, 1, 1), px(s, 0, 1), inside)
      this.quad(py(0, s, 0), py(1, s, 0), py(1, s, 1), py(0, s, 1), inside)
      this.quad(pz(0, 0, s), pz(1, 0, s), pz(1, 1, s), pz(0, 1, s), inside)
    }
    for (const a of [0, 1]) {
      for (const b of [0, 1]) {
        this.quad(px(a, b, 0), px(a, b, 1), py(a, b, 1), py(a, b, 0), inside)
        this.quad(px(a, 0, b), px(a, 1, b), pz(a, 1, b), pz(a, 0, b), inside)
        this.quad(py(0, a, b), py(1, a, b), pz(1, a, b), pz(0, a, b), inside)
        for (const d of [0, 1]) this.flat(px(a, b, d), py(a, b, d), pz(a, b, d), inside)
      }
    }
  }

  // The cheap everyday body: straight sides, a bevelled top edge and a flat underside.
  block(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c = 0.035) {
    const inside: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
    const low = y1 - c
    const a: V3[] = [[x0, low, z0], [x1, low, z0], [x1, low, z1], [x0, low, z1]]
    const b: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]
    const t: V3[] = [[x0 + c, y1, z0 + c], [x1 - c, y1, z0 + c], [x1 - c, y1, z1 - c], [x0 + c, y1, z1 - c]]
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      this.quad(b[i], b[j], a[j], a[i], inside)
      this.quad(a[i], a[j], t[j], t[i], inside)
    }
    this.quad(t[0], t[1], t[2], t[3], inside)
    this.quad(b[0], b[1], b[2], b[3], inside)
  }

  // Turns a profile of [radius, height] points around the y axis. List the points
  // from bottom to top along the outside, and the normals point outward.
  revolve(profile: Array<[number, number]>, cx: number, y0: number, cz: number, segments: number) {
    const ring = (i: number) => {
      const t = (i / segments) * Math.PI * 2
      return [Math.cos(t), Math.sin(t)] as const
    }
    for (let p = 0; p < profile.length - 1; p++) {
      const [r0, h0] = profile[p], [r1, h1] = profile[p + 1]
      const dr = r1 - r0, dh = h1 - h0
      const len = Math.hypot(dr, dh)
      if (len < 1e-9) continue
      const nr = dh / len, ny = -dr / len
      for (let i = 0; i < segments; i++) {
        const [c0, s0] = ring(i), [c1, s1] = ring(i + 1)
        const a: V3 = [cx + r0 * c0, y0 + h0, cz + r0 * s0]
        const b: V3 = [cx + r1 * c0, y0 + h1, cz + r1 * s0]
        const c: V3 = [cx + r1 * c1, y0 + h1, cz + r1 * s1]
        const d: V3 = [cx + r0 * c1, y0 + h0, cz + r0 * s1]
        const n0: V3 = [nr * c0, ny, nr * s0], n1: V3 = [nr * c1, ny, nr * s1]
        // With y up and the angle running x to z, this order faces outward.
        if (r1 > 1e-6) { this.push(a, n0); this.push(b, n0); this.push(c, n1) }
        if (r0 > 1e-6) { this.push(a, n0); this.push(c, n1); this.push(d, n1) }
      }
    }
  }

  // A convex [z, y] outline swept along x, with flat ends.
  prism(poly: Array<[number, number]>, x0: number, x1: number) {
    let cz = 0, cy = 0
    for (const [z, y] of poly) { cz += z / poly.length; cy += y / poly.length }
    const inside: V3 = [(x0 + x1) / 2, cy, cz]
    poly.forEach(([z, y], i) => {
      const [nz, ny] = poly[(i + 1) % poly.length]
      this.quad([x0, y, z], [x1, y, z], [x1, ny, nz], [x0, ny, nz], inside)
    })
    for (let i = 1; i < poly.length - 1; i++) {
      for (const x of [x0, x1]) {
        this.flat([x, poly[0][1], poly[0][0]], [x, poly[i][1], poly[i][0]], [x, poly[i + 1][1], poly[i + 1][0]], inside)
      }
    }
  }

  stud(x: number, y: number, z: number, radius = STUD_R) {
    this.revolve([[radius, 0], [radius, STUD_H], [0, STUD_H]], x, y, z, STUD_SEGMENTS)
  }

  studs(def: PartDef, top: number) {
    for (const [cx, cz] of def.rots[0].studs) this.stud(cx + 0.5 - def.w / 2, top - 0.005, cz + 0.5 - def.d / 2)
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    return geometry
  }
}

function arch(def: PartDef, top: number): THREE.BufferGeometry {
  const half = def.d / 2 - GAP
  const inner = def.d / 2 - 1
  const rise = (def.h - Math.max(1, Math.floor(def.h / 2))) * PLATE_H - 0.02
  const shape = new THREE.Shape()
  shape.moveTo(-half, 0.005)
  shape.lineTo(-inner, 0.005)
  shape.absellipse(0, 0.005, inner, rise, Math.PI, 0, true, 0)
  shape.lineTo(half, 0.005)
  shape.lineTo(half, top)
  shape.lineTo(-half, top)
  shape.closePath()
  const depth = def.w - GAP * 2
  const solid = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 })
  solid.translate(0, 0, -depth / 2)
  solid.rotateY(Math.PI / 2)
  const flat = solid.index ? solid.toNonIndexed() : solid
  const builder = new Builder()
  builder.studs(def, top)
  const studs = builder.build()
  const pos = [...flat.getAttribute('position').array, ...studs.getAttribute('position').array]
  const nor = [...flat.getAttribute('normal').array, ...studs.getAttribute('normal').array]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  return geometry
}

function makeSubs(def: PartDef): Sub[] {
  const top = def.h * PLATE_H
  const x0 = -def.w / 2 + GAP, x1 = def.w / 2 - GAP
  const z0 = -def.d / 2 + GAP, z1 = def.d / 2 - GAP
  const body = new Builder()
  const lip = 0.14

  switch (def.shape) {
    case 'box':
      body.block(x0, x1, 0.005, top, z0, z1)
      body.studs(def, top)
      return [{ geometry: body.build() }]

    case 'tile':
      body.block(x0, x1, 0.005, top - 0.008, z0, z1, 0.03)
      return [{ geometry: body.build() }]

    case 'slope': {
      const flatEnd = def.d > 1 ? z0 + 1 : z0 + 0.14
      body.prism([[z0, 0.005], [z1, 0.005], [z1, lip], [flatEnd, top], [z0, top]], x0, x1)
      body.studs(def, top)
      return [{ geometry: body.build() }]
    }

    case 'inverted':
      body.prism([[z0, 0.005], [z0 + 1, 0.005], [z1, top - lip], [z1, top], [z0, top]], x0, x1)
      body.studs(def, top)
      return [{ geometry: body.build() }]

    case 'ridge':
      body.prism([[z0, 0.005], [z1, 0.005], [z1, lip], [0.08, top], [-0.08, top], [z0, lip]], x0, x1)
      return [{ geometry: body.build() }]

    case 'round': {
      const r = def.w / 2 - GAP - 0.01
      body.revolve([[r, 0.005], [r, top - 0.03], [r - 0.03, top], [0, top]], 0, 0, 0, sides(def.w > 1 ? 24 : 14))
      body.studs(def, top)
      return [{ geometry: body.build() }]
    }

    case 'cone': {
      const r = def.w / 2 - GAP - 0.01
      const tip = def.w > 1 ? 0.14 : 0.3
      body.revolve([[r, 0.005], [r, 0.14], [tip, top], [0, top]], 0, 0, 0, sides(def.w > 1 ? 20 : 12))
      body.studs(def, top)
      return [{ geometry: body.build() }]
    }

    case 'arch':
      return [{ geometry: arch(def, top) }]

    case 'window': {
      const pane = new Builder()
      body.box(x0, x1, 0.005, 0.22, z0, z1)
      body.box(x0, x1, top - 0.22, top, z0, z1)
      body.box(x0, x1, 0.2, top - 0.2, z0, z0 + 0.16)
      body.box(x0, x1, 0.2, top - 0.2, z1 - 0.16, z1)
      body.box(-0.06, 0.06, 0.2, top - 0.2, -0.05, 0.05, 0.015)
      body.studs(def, top)
      pane.box(-0.03, 0.03, 0.2, top - 0.2, z0 + 0.15, z1 - 0.15, 0.005)
      return [{ geometry: body.build() }, { geometry: pane.build(), fixed: 0x9fd4f2, glass: true }]
    }

    case 'door': {
      const frame = new Builder()
      const knob = new Builder()
      frame.box(x0, x1, 0.005, 0.23, z0, z1)
      frame.box(x0, x1, top - 0.42, top, z0, z1)
      frame.box(x0, x1, 0.21, top - 0.4, z0, z0 + 0.3)
      frame.box(x0, x1, 0.21, top - 0.4, z1 - 0.3, z1)
      frame.studs(def, top)
      const zA = z0 + 0.29, zB = z1 - 0.29
      body.box(-0.12, 0.12, 0.22, top - 0.41, zA, zB, 0.02)
      const mid = (0.22 + top - 0.41) / 2
      for (const x of [-1, 1]) knob.revolve([[0.09, -0.08], [0.09, 0.08], [0, 0.09]], x * 0.17, mid - 0.05, zB - 0.3, 8)
      return [{ geometry: body.build() }, { geometry: frame.build(), fixed: 0xf4f4f0 }, { geometry: knob.build(), fixed: 0xd4a93a }]
    }

    case 'fence': {
      for (const z of [z0 + 0.48, z1 - 0.48]) {
        body.box(-0.22, 0.22, 0.005, top, z - 0.3, z + 0.3, 0.025)
      }
      body.box(x0, x1, 0.005, 0.23, z0, z1, 0.02)
      body.box(-0.07, 0.07, 0.46, 0.6, z0 + 0.5, z1 - 0.5, 0.02)
      body.box(-0.07, 0.07, 0.82, 0.96, z0 + 0.5, z1 - 0.5, 0.02)
      body.studs(def, top)
      return [{ geometry: body.build() }]
    }

    case 'wheels': {
      const radius = 0.96
      const tyres = new Builder()
      const hubs = new Builder()
      tyres.revolve([[0, -0.41], [0.86, -0.41], [radius, -0.3], [radius, 0.3], [0.86, 0.41], [0, 0.41]], 0, 0, 0, sides(20))
      hubs.revolve([[0, -0.44], [0.52, -0.44], [0.52, 0.44], [0, 0.44]], 0, 0, 0, sides(14))
      const place = (source: THREE.BufferGeometry) => {
        const both = [-1.48, 1.48].map((x) => {
          const copy = source.clone()
          copy.rotateZ(Math.PI / 2)
          copy.translate(x, radius, 0)
          return copy
        })
        const pos = [...both[0].getAttribute('position').array, ...both[1].getAttribute('position').array]
        const nor = [...both[0].getAttribute('normal').array, ...both[1].getAttribute('normal').array]
        const out = new THREE.BufferGeometry()
        out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
        return out
      }
      body.box(-1.06, 1.06, 0.6, top - 0.5, -0.5, 0.5)
      body.box(-0.98, 0.98, top - 0.52, top, -0.98, 0.98)
      body.studs(def, top)
      return [{ geometry: body.build() }, { geometry: place(tyres.build()), fixed: 0x1e2024 }, { geometry: place(hubs.build()), fixed: 0xc9ccd0 }]
    }

    case 'flower': {
      const stem = new Builder()
      const heart = new Builder()
      stem.revolve([[0.38, 0.005], [0.38, 0.24], [0, 0.24]], 0, 0, 0, 10)
      stem.revolve([[0.055, 0.2], [0.055, 0.94]], 0, 0, 0, 5)
      for (const [x, z, a] of [[-0.14, 0, 0.5], [0.14, 0, -0.5]]) {
        stem.box(x - 0.09, x + 0.09, 0.42 + a * 0.2, 0.46 + a * 0.2, z - 0.05, z + 0.05, 0.01)
      }
      for (let i = 0; i < 5; i++) {
        const t = (i / 5) * Math.PI * 2 + Math.PI / 10
        body.revolve([[0.17, 0], [0.17, 0.07], [0, 0.1]], Math.cos(t) * 0.22, 0.9, Math.sin(t) * 0.22, 7)
      }
      heart.revolve([[0.14, 0], [0.14, 0.12], [0, 0.15]], 0, 0.9, 0, 7)
      return [{ geometry: body.build() }, { geometry: stem.build(), fixed: 0x1f8f3c }, { geometry: heart.build(), fixed: 0xf7d117 }]
    }
  }
}

const cache = new Map<string, Sub[]>()

export function subsFor(part: string): Sub[] {
  let subs = cache.get(part)
  if (!subs) {
    subs = makeSubs(PART.get(part)!)
    cache.set(part, subs)
  }
  return subs
}

// A landing page brick: any size, with studs only on the given columns.
export function pieceGeometry(w: number, d: number, h: number, openColumns: number[]): THREE.BufferGeometry {
  const builder = new Builder()
  const top = h * PLATE_H
  builder.block(-w / 2 + GAP, w / 2 - GAP, 0.005, top, -d / 2 + GAP, d / 2 - GAP)
  for (const c of openColumns) {
    for (let z = 0; z < d; z++) builder.stud(c + 0.5 - w / 2, top - 0.005, z + 0.5 - d / 2)
  }
  return builder.build()
}

export function plainBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, chamfer: number): THREE.BufferGeometry {
  const builder = new Builder()
  builder.box(x0, x1, y0, y1, z0, z1, chamfer)
  return builder.build()
}

export function studsOn(positions: Array<[number, number, number]>, radius: number, height: number): THREE.BufferGeometry {
  const builder = new Builder()
  for (const [x, y, z] of positions) {
    builder.revolve([[radius, 0], [radius, height - 0.05], [radius - 0.05, height], [0, height]], x, y, z, 16)
  }
  return builder.build()
}
