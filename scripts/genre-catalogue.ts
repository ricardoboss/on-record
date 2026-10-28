import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Plugin } from 'vite'

/** Keep the bulk dataset out of the bundler's parser, minifier and source maps. */
export function genreCatalogue(): Plugin {
  let source: string
  let output: string
  let filename: string
  return {
    name: 'genre-catalogue',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      source = resolve(config.root, 'src/data/catalogue/genres.json')
      output = resolve(config.root, config.build.outDir, config.build.assetsDir)
    },
    async buildStart() {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(source)) hash.update(chunk)
      filename = `genre-catalogue-${hash.digest('hex').slice(0, 16)}.js`
    },
    resolveId(id) {
      if (id.endsWith('/catalogue/genres.json?raw')) {
        return { id: `./${filename}`, external: true }
      }
    },
    async closeBundle() {
      await mkdir(output, { recursive: true })
      async function* contents() {
        yield 'export default "'
        // Decoding UTF-8 before escaping preserves characters across chunk boundaries.
        for await (const chunk of createReadStream(source, { encoding: 'utf8' })) {
          yield JSON.stringify(chunk).slice(1, -1)
        }
        yield '";\n'
      }
      await pipeline(Readable.from(contents()), createWriteStream(resolve(output, filename)))
    },
  }
}
