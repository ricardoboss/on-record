import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { build } from 'vite'
import { genreCatalogue } from '../../scripts/genre-catalogue'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('streams a separate, content-hashed catalogue module with lossless text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'on-record-catalogue-'))
  directories.push(root)
  await mkdir(join(root, 'src/data/catalogue'), { recursive: true })
  const source = join(root, 'src/data/catalogue/genres.json')
  // Exercise escapes and UTF-8 characters spanning stream chunks.
  const text = JSON.stringify({ name: 'a'.repeat(65531) + '🎵 Beyoncé "\\\n', recordings: [] })
  await writeFile(source, text)
  await writeFile(join(root, 'src/main.js'), 'import text from "./data/catalogue/genres.json?raw"; export default text;')
  const compile = () => build({
    configFile: false, root, logLevel: 'silent', plugins: [genreCatalogue()],
    build: { rollupOptions: { input: join(root, 'src/main.js'), output: { entryFileNames: 'assets/main.js' } } },
  })
  await compile()
  const entry = await readFile(join(root, 'dist/assets/main.js'), 'utf8')
  const filename = entry.match(/genre-catalogue-[a-f0-9]+\.js/)?.[0]
  expect(filename).toBeDefined()
  const module = await readFile(join(root, 'dist/assets', filename!), 'utf8')
  expect(JSON.parse(module.slice('export default '.length, -2))).toBe(text)
  expect(entry).not.toContain('Beyoncé')
  expect(entry).toContain(`./${filename}`)
  await writeFile(source, '{"recordings":[]}')
  await compile()
  expect(await readFile(join(root, 'dist/assets/main.js'), 'utf8')).not.toContain(filename)
})
