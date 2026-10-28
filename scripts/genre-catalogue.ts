import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { gzipSync } from 'node:zlib'
import type { Plugin } from 'vite'

const MODULE = 'virtual:genre-catalogue'
const INTERNAL = '\0' + MODULE
const MAX_PART_BYTES = 4 * 1024 * 1024
const FORMAT = 'compressed-selective-worker-v2'
const SECTIONS = new Set(['artistNames', 'genreNames', 'recordings', 'recordingAliases', 'albumGenres', 'artistGenres'])

async function smallSnapshot(path: string): Promise<Record<string, unknown>> {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('Large genre catalogues must use the JSONL bulk export.')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function* snapshotParts(path: string) {
  const snapshot = await smallSnapshot(path)
  const metadata = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => !Array.isArray(value)))
  const recordings = (snapshot.recordings ?? []) as { artist: string; genres: string[] }[]
  metadata.counts ??= {
    recordings: recordings.length,
    artists: Array.isArray(snapshot.artistNames) ? snapshot.artistNames.length : new Set(recordings.map(row => row.artist)).size,
    genres: Array.isArray(snapshot.genreNames) ? snapshot.genreNames.length : new Set(recordings.flatMap(row => row.genres)).size,
    albumEntries: Array.isArray(snapshot.albumGenres) ? snapshot.albumGenres.length : 0,
    artistEntries: Array.isArray(snapshot.artistGenres) ? snapshot.artistGenres.length : 0,
  }
  yield JSON.stringify({ value: metadata })
  for (const [section, value] of Object.entries(snapshot)) {
    if (!Array.isArray(value)) continue
    let rows: unknown[] = [], size = 128
    for (const row of value) {
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes + 128 > MAX_PART_BYTES) throw new Error('A genre catalogue row exceeds the module size limit.')
      if (rows.length && (size + bytes >= MAX_PART_BYTES || rows.length >= 4096)) {
        yield JSON.stringify({ section, rows })
        rows = []; size = 128
      }
      rows.push(row); size += bytes
    }
    yield JSON.stringify({ section, rows })
  }
}

/** Keep bulk metadata out of Vite and below the browser's single-string limit. */
export function genreCatalogue(): Plugin {
  let snapshot: string, source: string, output: string, filename: string
  let production = false
  let log: (message: string) => void = () => {}
  return {
    name: 'genre-catalogue',
    enforce: 'pre',
    configResolved(config) {
      snapshot = resolve(config.root, 'src/data/catalogue/genres.json')
      source = resolve(config.root, 'src/data/catalogue/genres.jsonl')
      output = resolve(config.root, config.build.outDir, config.build.assetsDir)
      production = config.command === 'build'
      log = message => config.logger.info(message)
    },
    async buildStart() {
      if (!production) return
      try { await access(source) } catch { source = snapshot }
      const hash = createHash('sha256').update(FORMAT)
      for await (const chunk of createReadStream(source)) hash.update(chunk)
      filename = `genre-catalogue-${hash.digest('hex').slice(0, 16)}`
    },
    resolveId(id) {
      if (id !== MODULE) return
      return production ? { id: `./${filename}.js`, external: true } : INTERNAL
    },
    async load(id) {
      if (id !== INTERNAL) return
      const metadata: Record<string, unknown> = {}, parts: string[] = []
      const offsets = new Map<string, number>()
      for await (const text of snapshotParts(snapshot)) {
        const part = JSON.parse(text)
        if ('value' in part) Object.assign(metadata, part.value)
        else {
          const descriptor = partBounds(part, offsets)
          parts.push(`{...${JSON.stringify(descriptor)},load:async()=>(${text})}`)
        }
      }
      return `export default {metadata:${JSON.stringify(metadata)},parts:[${parts.join(',')}]};`
    },
    async closeBundle() {
      if (!production) return
      await mkdir(output, { recursive: true })
      const lines = source.endsWith('.jsonl')
        ? createInterface({ input: createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity })
        : snapshotParts(source)
      const metadata: Record<string, unknown> = {}, parts: string[] = [], importers: string[] = []
      const offsets = new Map<string, number>()
      for await (const text of lines) {
        if (!text.trim()) continue
        if (Buffer.byteLength(text) + 1 > MAX_PART_BYTES) throw new Error('A genre catalogue chunk exceeds 4 MiB.')
        const part = JSON.parse(text)
        if ('value' in part) { Object.assign(metadata, part.value); continue }
        if (!SECTIONS.has(part.section) || !Array.isArray(part.rows)) throw new Error('Invalid genre catalogue section.')
        const descriptor = partBounds(part, offsets)
        const file = `${filename}-${parts.length}.js`
        const payload = gzipSync(text).toString('base64')
        await writeFile(resolve(output, file), `export default ${JSON.stringify(payload)};\n`)
        importers.push(JSON.stringify(`./${file}`))
        parts.push(`{...${JSON.stringify(descriptor)},load:()=>read(payloads[${parts.length}])}`)
        if (parts.length % 100 === 0) log(`Genre catalogue: compressed ${parts.length} parts`)
      }
      // Short-lived workers own the module cache. The page keeps only compressed
      // public blobs until it has selected the history's matching rows.
      const worker = `self.onmessage = async ({data: files}) => {
  try {
    const buffers = [];
    for (const file of files) {
      const {default: payload} = await import(file);
      buffers.push(Uint8Array.from(atob(payload), c => c.charCodeAt(0)).buffer);
    }
    self.postMessage({buffers}, buffers);
  } catch { self.postMessage({error:'Could not load local genre catalogue'}); }
};
export {};
`
      await writeFile(resolve(output, `${filename}-worker.js`), worker)
      const reader = `async function read(blob) {
  if (!blob) throw new Error('Genre catalogue session is closed');
  return JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
const metadata=${JSON.stringify(metadata)};
const files=[${importers.join(',')}];
function createSession() {
  const payloads = [];
  const workers = new Map();
  function release() {
    payloads.length = 0;
    for (const [worker, reject] of workers) {
      worker.terminate();
      reject(new DOMException('Genre loading canceled', 'AbortError'));
    }
    workers.clear();
  }
  function pull(batch) {
    return new Promise((resolve,reject) => {
      const worker = new Worker(new URL('./${filename}-worker.js',import.meta.url), {type:'module'});
      workers.set(worker,reject);
      const finish = () => {workers.delete(worker);worker.terminate();};
      worker.onmessage = ({data}) => {
        finish();
        if (data.error) reject(new Error(data.error)); else resolve(data.buffers);
      };
      worker.onerror = () => {finish();reject(new Error('Could not load local genre catalogue'));};
      worker.postMessage(batch);
    });
  }
  async function prepare(progress) {
    for (let i=0;i<files.length;i+=8) {
      const buffers = await pull(files.slice(i,i+8));
      for (let j=0;j<buffers.length;j++) payloads[i+j] = new Blob([buffers[j]]);
      progress?.(Math.min(i+8,files.length));
    }
  }
  return {metadata,parts:[${parts.join(',')}],prepare,release};
}
export default {metadata,parts:[],createSession};
`
      await writeFile(resolve(output, `${filename}.js`), reader)
      log(`Genre catalogue: ${parts.length} compressed local parts`)
    },
  }
}

function partBounds(part: { section: string; rows: unknown[] }, offsets: Map<string, number>) {
  const start = offsets.get(part.section) ?? 0
  offsets.set(part.section, start + part.rows.length)
  if (part.section === 'artistNames' || part.section === 'genreNames') {
    return { section: part.section, start, min: start, max: start + part.rows.length - 1, first: part.rows[0], last: part.rows.at(-1) }
  }
  const first = part.rows[0], last = part.rows.at(-1)
  return { section: part.section, min: Array.isArray(first) ? first[0] : undefined, max: Array.isArray(last) ? last[0] : undefined }
}
