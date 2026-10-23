import { copyFile, mkdir } from 'node:fs/promises'

const contractDest = new URL('../dist/contract/', import.meta.url)
await mkdir(contractDest, { recursive: true })
for (const name of [
  'observation-envelope.schema.json',
  'observation-protobuf-view.schema.json',
  'observation-v1.mjs',
]) {
  await copyFile(
    new URL(`../src/contract/${name}`, import.meta.url),
    new URL(name, contractDest),
  )
}

const analyzeSchemaDest = new URL('../dist/analyze/schemas/', import.meta.url)
await mkdir(analyzeSchemaDest, { recursive: true })
await copyFile(
  new URL('../src/analyze/schemas/resource-finding.schema.json', import.meta.url),
  new URL('resource-finding.schema.json', analyzeSchemaDest),
)
