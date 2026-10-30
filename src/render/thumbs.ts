// Pictures of parts, rendered from the real models, so the menus always show exactly
// what lands on the baseplate. One small renderer draws them all in a single pass.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { COLOR } from '../core/colors.ts'
import { PART } from '../core/parts.ts'
import { subsFor } from './geometry.ts'

const SIZE = 128

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
const solid = new THREE.MeshStandardMaterial({ roughness: 0.3 })
const clear = new THREE.MeshStandardMaterial({ roughness: 0.08, transparent: true, opacity: 0.55, depthWrite: false })

function setup() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(SIZE, SIZE, false)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.setClearColor(0x000000, 0)
  scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.6
  pmrem.dispose()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555560, 0.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.1)
  key.position.set(-3, 7, 4)
  scene.add(key)
  camera = new THREE.PerspectiveCamera(24, 1, 0.1, 200)
}

// Draws a part in a colour onto a 2D canvas.
export function drawThumb(target: HTMLCanvasElement, part: string, colorId: string) {
  if (!renderer) setup()
  const def = PART.get(part)!
  const hex = COLOR.get(colorId)!.hex
  const isGlass = Boolean(COLOR.get(colorId)!.glass)
  const group = new THREE.Group()
  const owned: THREE.Material[] = []
  for (const sub of subsFor(part)) {
    const material = (sub.glass || (isGlass && sub.fixed === undefined) ? clear : solid).clone()
    material.color.setHex(sub.fixed ?? hex)
    owned.push(material)
    group.add(new THREE.Mesh(sub.geometry, material))
  }
  // Parts with a long side lie across the picture, so a row of them reads at a glance.
  if (def.w < def.d) group.rotation.y = -Math.PI / 2
  scene.add(group)

  const box = new THREE.Box3().setFromObject(group)
  const center = box.getCenter(new THREE.Vector3())
  const radius = box.getSize(new THREE.Vector3()).length() / 2
  const distance = Math.max(radius, 1.1) / Math.sin((camera.fov * Math.PI) / 360) * 0.98
  camera.position.copy(center).add(new THREE.Vector3(-0.55, 0.75, 1).normalize().multiplyScalar(distance))
  camera.lookAt(center)
  renderer!.render(scene, camera)

  const ratio = window.devicePixelRatio || 1
  const css = target.clientWidth || target.width
  const pixels = Math.round(css * Math.min(ratio, 2))
  if (target.width !== pixels) { target.width = pixels; target.height = pixels }
  const g = target.getContext('2d')!
  g.clearRect(0, 0, pixels, pixels)
  g.imageSmoothingQuality = 'high'
  g.drawImage(renderer!.domElement, 0, 0, pixels, pixels)

  scene.remove(group)
  owned.forEach((material) => material.dispose())
}
