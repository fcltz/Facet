import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync, crc32 } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Mesmo desenho de FacetLogo: rasterização com supersampling, sem dependências nativas.
const root = new URL('../build/', import.meta.url)
await mkdir(root, { recursive: true })
const polygon = (x, y, points) => {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i],
      [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const blend = (base, color, opacity) => base.map((v, i) => v * (1 - opacity) + color[i] * opacity)
function pixel(x, y) {
  const dx = Math.max(9 - x, 0, x - 23),
    dy = Math.max(9 - y, 0, y - 23)
  if (dx * dx + dy * dy > 81) return [0, 0, 0, 0]
  const ratio = (x + y) / 64
  let color = [124, 124, 251].map((v, i) => v + ([70, 70, 230][i] - v) * ratio)
  if (
    polygon(x, y, [
      [16, 6.5],
      [24.5, 12.5],
      [16, 25.5],
      [7.5, 12.5],
    ])
  )
    color = blend(color, [255, 255, 255], 0.96)
  if (
    polygon(x, y, [
      [7.5, 12.5],
      [24.5, 12.5],
      [16, 25.5],
    ])
  )
    color = blend(color, [255, 255, 255], 0.62)
  if (
    polygon(x, y, [
      [12.2, 12.5],
      [16, 6.5],
      [19.8, 12.5],
      [16, 25.5],
    ])
  )
    color = blend(color, [70, 70, 230], 0.18)
  return [...color, 255]
}
function chunk(type, data) {
  const tag = Buffer.from(type),
    size = Buffer.alloc(4),
    checksum = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])))
  return Buffer.concat([size, tag, data, checksum])
}
function png(size) {
  const rows = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const sample = pixel(((x + (sx + 0.5) / 4) * 32) / size, ((y + (sy + 0.5) / 4) * 32) / size)
          for (let i = 0; i < 4; i++) sum[i] += sample[i]
        }
      // RGB não pré-multiplicado; evita bordas escuras nos cantos transparentes.
      const alpha = sum[3] / (16 * 255)
      const offset = y * (1 + size * 4) + 1 + x * 4
      for (let i = 0; i < 3; i++) rows[offset + i] = alpha ? Math.round(sum[i] / (16 * alpha)) : 0
      rows[offset + 3] = Math.round(sum[3] / 16)
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map(png),
  directory = Buffer.alloc(6 + sizes.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16
  directory[entry] = directory[entry + 1] = sizes[i] === 256 ? 0 : sizes[i]
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(images[i].length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += images[i].length
}
await writeFile(new URL('icon.ico', root), Buffer.concat([directory, ...images]))
await writeFile(new URL('icon.png', root), images.at(-1))
const extensionRoot = new URL('../resources/facet-extension/', import.meta.url)
await mkdir(extensionRoot, { recursive: true })
for (const size of [16, 32, 48, 128])
  await writeFile(new URL(`icon${size}.png`, extensionRoot), images[sizes.indexOf(size)])
process.stdout.write(`Ícones gerados em ${fileURLToPath(root)}\n`)
