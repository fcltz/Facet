import { crc32, deflateSync } from 'node:zlib'

/**
 * Ícone de identificação do perfil: quadrado roxo (mesmo degradê do logo do Facet) com o
 * número em branco. Dígitos desenhados como traços (sem fontes nem dependências nativas),
 * rasterizados com supersampling 4×4, como o `scripts/make-icon.mjs`.
 */

type Point = readonly [number, number]
type Stroke = readonly Point[]

/** Caixa de cada dígito, em unidades do desenho (y para baixo). */
const BOX_W = 10
const BOX_H = 16
const TRACKING = 1.6
const STROKE = 2.3

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 20): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const angle = ((from + ((to - from) * i) / steps) * Math.PI) / 180
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)])
  }
  return points
}

function quad(p0: Point, p1: Point, p2: Point, steps = 16): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    points.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]])
  }
  return points
}

/** Traços de cada dígito numa caixa 10×16 (ângulos em graus, 90° aponta para baixo). */
export const DIGIT_STROKES: Readonly<Record<string, readonly Stroke[]>> = {
  '0': [arc(5, 8, 3.6, 6.2, 0, 360, 36)],
  '1': [
    [
      [2.6, 4.3],
      [5.7, 1.8],
      [5.7, 14.2],
    ],
  ],
  '2': [[...arc(5, 5.2, 3.4, 3.4, 200, 380, 18), [1.6, 14.2], [8.6, 14.2]]],
  '3': [arc(5, 4.95, 3.2, 3.05, 205, 450, 18), arc(5, 11.1, 3.5, 3.1, 270, 510, 18)],
  '4': [
    [
      [6.8, 14.2],
      [6.8, 1.8],
      [1.3, 10.6],
      [9, 10.6],
    ],
  ],
  '5': [
    [
      [8.3, 1.8],
      [2.4, 1.8],
      [2.1, 7.5],
    ],
    arc(4.8, 10.3, 3.7, 3.9, 228, 510, 22),
  ],
  '6': [arc(5, 10.4, 3.5, 3.8, 0, 360, 32), quad([7.6, 1.9], [1.5, 3.2], [1.5, 10.4])],
  '7': [
    [
      [1.5, 1.8],
      [8.5, 1.8],
      [3.8, 14.2],
    ],
  ],
  '8': [arc(5, 4.85, 3, 3.05, 0, 360, 28), arc(5, 11, 3.5, 3.2, 0, 360, 30)],
  '9': [arc(5, 5.6, 3.5, 3.8, 0, 360, 32), quad([2.4, 14.1], [8.5, 12.8], [8.5, 5.6])],
}

interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const TOP: readonly [number, number, number] = [124, 124, 251]
const BOTTOM: readonly [number, number, number] = [70, 70, 230]

/** Segmentos do texto já posicionados no ícone `size`×`size` (em pixels). */
function layout(text: string, size: number): { segments: Segment[]; radius: number } {
  const digits = [...text].filter((char) => DIGIT_STROKES[char])
  const width = digits.length * BOX_W + Math.max(0, digits.length - 1) * TRACKING
  const scale = Math.min((size * 0.74) / width, (size * 0.56) / BOX_H)
  // traço mínimo de 1,5 px para continuar legível em 16×16
  const radius = Math.max(STROKE * scale, 1.5) / 2
  const offsetX = (size - width * scale) / 2
  const offsetY = (size - BOX_H * scale) / 2
  const segments: Segment[] = []
  digits.forEach((digit, index) => {
    const left = offsetX + index * (BOX_W + TRACKING) * scale
    for (const stroke of DIGIT_STROKES[digit]!) {
      for (let i = 1; i < stroke.length; i++) {
        const ax = left + stroke[i - 1]![0] * scale
        const ay = offsetY + stroke[i - 1]![1] * scale
        const bx = left + stroke[i]![0] * scale
        const by = offsetY + stroke[i]![1] * scale
        segments.push({
          ax,
          ay,
          bx,
          by,
          minX: Math.min(ax, bx) - radius,
          maxX: Math.max(ax, bx) + radius,
          minY: Math.min(ay, by) - radius,
          maxY: Math.max(ay, by) + radius,
        })
      }
    }
  })
  return { segments, radius }
}

function onStroke(x: number, y: number, segments: readonly Segment[], radius: number): boolean {
  const limit = radius * radius
  for (const s of segments) {
    if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) continue
    const dx = s.bx - s.ax
    const dy = s.by - s.ay
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / length))
    const px = s.ax + t * dx - x
    const py = s.ay + t * dy - y
    if (px * px + py * py <= limit) return true
  }
  return false
}

function insideRoundedSquare(x: number, y: number, size: number, corner: number): boolean {
  const cx = Math.max(corner - x, 0, x - (size - corner))
  const cy = Math.max(corner - y, 0, y - (size - corner))
  return cx * cx + cy * cy <= corner * corner
}

/** Linhas RGBA (cada uma começando com o byte de filtro 0) prontas para o IDAT do PNG. */
export function renderBadge(size: number, text: string): Buffer {
  const { segments, radius } = layout(text, size)
  const corner = size * 0.22
  const rows = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4
          const py = y + (sy + 0.5) / 4
          if (!insideRoundedSquare(px, py, size, corner)) continue
          const ratio = (px + py) / (2 * size)
          const color = onStroke(px, py, segments, radius)
            ? [255, 255, 255]
            : TOP.map((value, i) => value + (BOTTOM[i]! - value) * ratio)
          sum[0]! += color[0]!
          sum[1]! += color[1]!
          sum[2]! += color[2]!
          sum[3]! += 255
        }
      }
      // RGB não pré-multiplicado: evita bordas escuras nos cantos transparentes
      const alpha = sum[3]! / (16 * 255)
      const offset = y * (1 + size * 4) + 1 + x * 4
      for (let i = 0; i < 3; i++) rows[offset + i] = alpha ? Math.round(sum[i]! / (16 * alpha)) : 0
      rows[offset + 3] = Math.round(sum[3]! / 16)
    }
  }
  return rows
}

function chunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])))
  return Buffer.concat([length, tag, data, checksum])
}

export function badgePng(size: number, text: string): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // 8 bits por canal
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(renderBadge(size, text))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** .ico com imagens PNG (aceito pelo Windows desde o Vista), uma por tamanho. */
export function badgeIco(text: string, sizes: readonly number[] = [16, 24, 32, 48, 64, 256]): Buffer {
  const images = sizes.map((size) => badgePng(size, text))
  const directory = Buffer.alloc(6 + sizes.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(sizes.length, 4)
  let offset = directory.length
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16
    directory[entry] = directory[entry + 1] = size >= 256 ? 0 : size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(images[index]!.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += images[index]!.length
  })
  return Buffer.concat([directory, ...images])
}
