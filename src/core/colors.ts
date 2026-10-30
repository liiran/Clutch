// The colour palette. Each colour has one letter, used by the chat's voxel layers.

export interface ColorDef {
  id: string
  name: string
  hex: number
  letter: string
  glass?: boolean
}

export const COLORS: ColorDef[] = [
  { id: 'red', name: 'Red', hex: 0xd01012, letter: 'r' },
  { id: 'orange', name: 'Orange', hex: 0xf57d20, letter: 'o' },
  { id: 'yellow', name: 'Yellow', hex: 0xf7d117, letter: 'y' },
  { id: 'lime', name: 'Lime', hex: 0xa5ca18, letter: 'l' },
  { id: 'green', name: 'Green', hex: 0x1f8f3c, letter: 'g' },
  { id: 'forest', name: 'Forest', hex: 0x184632, letter: 'd' },
  { id: 'sky', name: 'Sky', hex: 0x5bb5e8, letter: 'a' },
  { id: 'blue', name: 'Blue', hex: 0x0b5cc0, letter: 'b' },
  { id: 'navy', name: 'Navy', hex: 0x0d2f5e, letter: 'n' },
  { id: 'purple', name: 'Purple', hex: 0x6f3aa6, letter: 'p' },
  { id: 'pink', name: 'Pink', hex: 0xf08fb0, letter: 'k' },
  { id: 'white', name: 'White', hex: 0xf4f4f0, letter: 'w' },
  { id: 'lightgray', name: 'Light gray', hex: 0xa3a6a8, letter: 'e' },
  { id: 'darkgray', name: 'Dark gray', hex: 0x5c6064, letter: 'h' },
  { id: 'black', name: 'Black', hex: 0x1e2024, letter: 'x' },
  { id: 'tan', name: 'Tan', hex: 0xe4cd9e, letter: 't' },
  { id: 'sand', name: 'Sand', hex: 0x958a73, letter: 'c' },
  { id: 'brown', name: 'Brown', hex: 0x6b3f22, letter: 'u' },
  { id: 'darkred', name: 'Dark red', hex: 0x7b1a1a, letter: 'q' },
  { id: 'glass', name: 'Clear glass', hex: 0xe8f2f7, letter: 'i', glass: true },
  { id: 'glassblue', name: 'Blue glass', hex: 0x6fb7ec, letter: 'j', glass: true },
  { id: 'glassred', name: 'Red glass', hex: 0xe8483c, letter: 'f', glass: true },
]

export const COLOR = new Map(COLORS.map((color) => [color.id, color]))
export const COLOR_BY_LETTER = new Map(COLORS.map((color) => [color.letter, color]))
export const COLOR_IDS = COLORS.map((color) => color.id)
export const DEFAULT_COLOR = 'red'
