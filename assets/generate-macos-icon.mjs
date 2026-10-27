import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const source = fileURLToPath(new URL('./AgentLoop-icon-source.png', import.meta.url))
const output = fileURLToPath(new URL('./AgentLoop.icns', import.meta.url))
const sizes = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]

const image = await readFile(source)
const chunks = await Promise.all(sizes.map(async ([type, size]) => {
  const png = await sharp(image).resize(size, size).png().toBuffer()
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(header.length + png.length, 4)
  return Buffer.concat([header, png])
}))
const header = Buffer.alloc(8)
header.write('icns', 0, 4, 'ascii')
header.writeUInt32BE(header.length + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
await writeFile(output, Buffer.concat([header, ...chunks]))
process.stdout.write(`Generated ${output}\n`)
