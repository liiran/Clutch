// How the placement ghost locks onto the studs. It should feel like it clicks into place:
// it holds its spot until the pointer has clearly moved past a stud, and when it is near
// lining up with the piece under it, it lines up.

const HOLD = 0.2      // how far past the halfway point the pointer must go to change stud
const MAGNET = 0.9    // how near to lining up, in studs, before it pulls into line

// The stud nearest `ideal`, staying on `held` until the pointer has clearly left it.
export function holdStud(ideal: number, held: number | null): number {
  if (held !== null && Math.abs(ideal - held) < 0.5 + HOLD) return held
  return Math.round(ideal)
}

// Pulls `ideal` onto a whole-stud alignment with a piece of `size` studs at `at`, for a
// ghost of `own` studs: lined up with either edge, or centred when that lands on a stud.
export function alignTo(ideal: number, own: number, at: number, size: number): number {
  const options = [at, at + size - own]
  const centred = at + (size - own) / 2
  if (Number.isInteger(centred)) options.push(centred)
  let best = ideal
  let bestGap = MAGNET
  for (const option of options) {
    const gap = Math.abs(ideal - option)
    if (gap <= bestGap) {
      best = option
      bestGap = gap
    }
  }
  return best
}
