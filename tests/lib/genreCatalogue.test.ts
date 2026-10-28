import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker as NodeWorker } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { genreCatalogue } from '../../scripts/genre-catalogue'
import type { CatalogueBundle } from '../../src/data/genreCatalogue'

async function materialize(bundle: CatalogueBundle) {
  const session = bundle.createSession?.() ?? bundle
  const result: Record<string, unknown> = { ...session.metadata }
  try {
    await session.prepare?.()
    for (const part of session.parts) {
      const chunk = await part.load()
      const rows = (result[part.section] ??= []) as unknown[]
      rows.push(...chunk.rows)
    }
    return result
  } finally { session.release?.() }
}

// Run the actual generated worker against Node's worker threads, with the
// browser message API supplied at the boundary.
class BrowserWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  worker: NodeWorker
  constructor(url: URL) {
    this.worker = new NodeWorker(`
      const {parentPort}=require('node:worker_threads');
      globalThis.self={postMessage:(data,transfers)=>parentPort.postMessage(data,transfers)};
      import(${JSON.stringify(url.href)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));
    `, { eval: true })
    this.worker.on('message', data => this.onmessage?.({ data }))
    this.worker.on('error', error => this.onerror?.({ message: error instanceof Error ? error.message : String(error) }))
  }
  postMessage(data: unknown) { this.worker.postMessage(data) }
  terminate() { void this.worker.terminate() }
}
beforeEach(() => vi.stubGlobal('Worker', BrowserWorker))

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('emits content-hashed lazy compressed modules with lossless Unicode and escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'on-record-catalogue-'))
  directories.push(root)
  await mkdir(join(root, 'src/data/catalogue'), { recursive: true })
  const source = join(root, 'src/data/catalogue/genres.json')
  // Exercise escapes and UTF-8 characters spanning stream chunks.
  const text = JSON.stringify({ name: 'a'.repeat(65531) + '🎵 Beyoncé "\\\n', recordings: [] })
  await writeFile(source, text)
  await writeFile(join(root, 'src/main.js'), 'import catalogue from "virtual:genre-catalogue"; console.log(catalogue);')
  const compile = () => build({
    configFile: false, root, logLevel: 'silent', plugins: [genreCatalogue()],
    build: { rollupOptions: { input: join(root, 'src/main.js'), output: { entryFileNames: 'assets/main.js' } } },
  })
  await compile()
  const entry = await readFile(join(root, 'dist/assets/main.js'), 'utf8')
  const filename = entry.match(/genre-catalogue-[a-f0-9]+\.js/)?.[0]
  expect(filename).toBeDefined()
  const module = await import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/assets', filename!)).href)
  expect(await materialize(module.default)).toMatchObject(JSON.parse(text))
  expect(entry).not.toContain('Beyoncé')
  expect(entry).toContain(`./${filename}`)
  await writeFile(source, '{"recordings":[]}')
  await compile()
  expect(await readFile(join(root, 'dist/assets/main.js'), 'utf8')).not.toContain(filename)
})

it('decodes bounded JSONL parts on demand without materializing the catalogue at import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'on-record-catalogue-'))
  directories.push(root)
  await mkdir(join(root, 'src/data/catalogue'), { recursive: true })
  const lines = [
    { value: { schemaVersion: 2 } },
    { section: 'artistNames', rows: ['Beyoncé', '🎵'] },
    { section: 'recordings', rows: [[0, 'song', [], [0]]] },
    { section: 'recordings', rows: [[1, 'other', [], [1]]] },
    { value: { counts: { recordings: 2 } } },
  ]
  await writeFile(join(root, 'src/data/catalogue/genres.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  await writeFile(join(root, 'main.js'), 'import catalogue from "virtual:genre-catalogue"; console.log(catalogue);')
  await build({ configFile: false, root, logLevel: 'silent', plugins: [genreCatalogue()], build: { rollupOptions: { input: join(root, 'main.js'), output: { entryFileNames: 'assets/main.js' } } } })
  const entry = await readFile(join(root, 'dist/assets/main.js'), 'utf8')
  const filename = entry.match(/genre-catalogue-[a-f0-9]+\.js/)![0]
  const { default: catalogue } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/assets', filename)).href)
  expect(catalogue.parts).toHaveLength(0)
  const session = catalogue.createSession()
  expect(session.parts).toHaveLength(3)
  expect(session.parts[0]).not.toHaveProperty('rows')
  expect(session.parts[0]).toMatchObject({ section: 'artistNames', start: 0, min: 0, max: 1, first: 'Beyoncé', last: '🎵' })
  const progress: number[] = []
  await session.prepare((count: number) => progress.push(count))
  expect(progress.at(-1)).toBe(3)
  session.release()
  expect(await materialize(catalogue)).toEqual({ schemaVersion: 2, artistNames: ['Beyoncé', '🎵'], recordings: [[0, 'song', [], [0]], [1, 'other', [], [1]]], counts: { recordings: 2 } })
  const module = await readFile(join(root, 'dist/assets', filename), 'utf8')
  expect(module).not.toMatch(/^import /m)
})

it('rejects an oversized JSONL chunk instead of creating an unbounded string literal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'on-record-catalogue-'))
  directories.push(root)
  await mkdir(join(root, 'src/data/catalogue'), { recursive: true })
  await writeFile(join(root, 'src/data/catalogue/genres.jsonl'), JSON.stringify({ value: { text: 'a'.repeat(4 * 1024 * 1024) } }) + '\n')
  await writeFile(join(root, 'main.js'), 'import catalogue from "virtual:genre-catalogue"; console.log(catalogue);')
  await expect(build({ configFile: false, root, logLevel: 'silent', plugins: [genreCatalogue()], build: { rollupOptions: { input: join(root, 'main.js') } } })).rejects.toThrow('4 MiB')
})
