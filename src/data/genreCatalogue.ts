import bundledCatalogue from 'virtual:genre-catalogue'
import type { Play } from '../types'
import { createCatalogueResolver, normalizeGenreName } from './genreLookup'
import type { CompactGenreCatalogue, GenreRecording, GenreResolver } from './genreLookup'

export type CatalogueSection = 'artistNames' | 'genreNames' | 'recordings' | 'recordingAliases' | 'albumGenres' | 'artistGenres'
export interface CataloguePart {
  section: CatalogueSection
  start?: number
  min?: number
  max?: number
  first?: string
  last?: string
  load: () => Promise<{ section: string; rows: unknown[] }>
}
export interface CatalogueBundle {
  metadata: {
    schemaVersion?: 1 | 2
    snapshot?: string
    counts?: { recordings: number; artists: number; genres: number; albumEntries?: number; artistEntries?: number }
  }
  parts: CataloguePart[]
  /** Warm public payloads in a fixed order before inspecting private history keys. */
  prepare?: (onProgress?: (count: number) => void) => Promise<void>
  createSession?: () => CatalogueBundle
  release?: () => void
}
export interface CatalogueInfo {
  snapshot?: string
  recordings: number
  artists: number
  genres: number
  albums: number
  artistEstimates: number
}
interface LoadOptions {
  signal?: AbortSignal
  onProgress?: (count: number) => void
}

const bundle = bundledCatalogue as CatalogueBundle
const counts = bundle.metadata?.counts
export const catalogueInfo: CatalogueInfo = {
  snapshot: bundle.metadata?.snapshot,
  recordings: counts?.recordings ?? 0,
  artists: counts?.artists ?? 0,
  genres: counts?.genres ?? 0,
  albums: counts?.albumEntries ?? 0,
  artistEstimates: counts?.artistEntries ?? 0,
}

function lowerBound<T extends string | number>(values: readonly T[], value: T): number {
  let lo = 0, hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function intersects(part: { min?: number; max?: number }, ids: readonly number[]): boolean {
  if (!ids.length) return false
  if (part.min === undefined || part.max === undefined) return true
  const candidate = ids[lowerBound(ids, part.min)]
  return candidate !== undefined && candidate <= part.max
}

/** Only the uploaded history's keys enter memory; catalogue modules contain public metadata. */
export async function projectGenreCatalogue(source: CatalogueBundle, plays: readonly Play[], options: LoadOptions = {}): Promise<GenreResolver> {
  if (source.createSession) {
    const session = source.createSession()
    const release = () => session.release?.()
    options.signal?.addEventListener('abort', release, { once: true })
    try { return await projectGenreCatalogue(session, plays, options) }
    finally {
      options.signal?.removeEventListener('abort', release)
      release()
    }
  }
  const check = () => {
    if (options.signal?.aborted) throw new DOMException('Genre loading canceled', 'AbortError')
  }
  let completed = 0
  async function read(part: CataloguePart) {
    check()
    const chunk = await part.load()
    check()
    if (chunk.section !== part.section || !Array.isArray(chunk.rows)) throw new Error('Invalid local genre catalogue chunk')
    options.onProgress?.(++completed)
    check()
    return chunk.rows
  }
  check()
  await source.prepare?.(count => {
    check()
    completed = count
    options.onProgress?.(completed)
    check()
  })
  check()
  if (source.metadata.schemaVersion !== 2) {
    const recordings: GenreRecording[] = []
    for (const part of source.parts) {
      if (part.section === 'recordings') for (const row of await read(part)) recordings.push(row as GenreRecording)
    }
    check()
    return createCatalogueResolver({ schemaVersion: 1, recordings })
  }

  const queries = new Map<string, { titles: Set<string>; albums: Set<string> }>()
  for (const play of plays) {
    if (play.kind !== 'track') continue
    const artist = normalizeGenreName(play.artist)
    let query = queries.get(artist)
    if (!query) {
      query = { titles: new Set(), albums: new Set() }
      queries.set(artist, query)
    }
    query.titles.add(normalizeGenreName(play.title))
    query.albums.add(normalizeGenreName(play.album))
  }
  if (!queries.size) return createCatalogueResolver({ schemaVersion: 2, artistNames: [], genreNames: [], recordings: [] })
  const names = new Map<number, string>()
  const initial = new Map<number, { titles: Set<string>; albums: Set<string> }>()
  const requestedNames = [...queries.keys()].sort()
  const nameRanges: { part: CataloguePart; min: number; max: number }[] = []
  let offset = 0
  for (const part of source.parts) {
    if (part.section !== 'artistNames') continue
    const start = part.start ?? part.min ?? offset
    const candidate = part.first === undefined ? undefined : requestedNames[lowerBound(requestedNames, part.first)]
    const lexicalMiss = !requestedNames.length || (part.first !== undefined && part.last !== undefined && (candidate === undefined || candidate > part.last))
    if (lexicalMiss && part.max !== undefined) {
      nameRanges.push({ part, min: start, max: part.max })
      offset = part.max + 1
      continue
    }
    const rows = await read(part) as string[]
    const end = start + rows.length - 1
    nameRanges.push({ part, min: start, max: end })
    offset = end + 1
    for (let i = 0; i < rows.length; i++) {
      const query = queries.get(rows[i])
      if (query) {
        names.set(start + i, rows[i])
        initial.set(start + i, query)
      }
    }
  }

  const initialIds = [...initial.keys()].sort((a, b) => a - b)
  const neededTitles = new Map([...initial].map(([id, query]) => [id, new Set(query.titles)]))
  const aliases: NonNullable<CompactGenreCatalogue['recordingAliases']> = []
  for (const part of source.parts) {
    if (part.section !== 'recordingAliases' || !intersects(part, initialIds)) continue
    for (const row of await read(part) as [number, number][]) {
      const query = initial.get(row[0])
      if (!query) continue
      aliases.push(row)
      let titles = neededTitles.get(row[1])
      if (!titles) neededTitles.set(row[1], titles = new Set())
      for (const title of query.titles) titles.add(title)
    }
  }
  const missingNames = [...neededTitles.keys()].filter(id => !names.has(id)).sort((a, b) => a - b)
  for (const range of nameRanges) {
    if (!intersects(range, missingNames)) continue
    const rows = await read(range.part) as string[]
    for (let i = lowerBound(missingNames, range.min); i < missingNames.length && missingNames[i] <= range.max; i++) {
      const id = missingNames[i]
      const name = rows[id - range.min]
      if (typeof name !== 'string') throw new Error('Invalid local genre artist dictionary')
      names.set(id, name)
    }
  }

  const genreNames: string[] = []
  const recordings: CompactGenreCatalogue['recordings'] = []
  const albums: NonNullable<CompactGenreCatalogue['albumGenres']> = []
  const artists: NonNullable<CompactGenreCatalogue['artistGenres']> = []
  const neededIds = [...neededTitles.keys()].sort((a, b) => a - b)
  for (const part of source.parts) {
    if (part.section === 'genreNames') {
      if (initialIds.length) for (const row of await read(part)) genreNames.push(row as string)
    } else if (part.section === 'recordings' && intersects(part, neededIds)) {
      // Keep every candidate for each requested title: a different album or an
      // untagged sibling can still make the direct recording match ambiguous.
      for (const row of await read(part) as CompactGenreCatalogue['recordings']) {
        if (neededTitles.get(row[0])?.has(row[1])) recordings.push(row)
      }
    } else if (part.section === 'albumGenres' && intersects(part, initialIds)) {
      for (const row of await read(part) as typeof albums) if (initial.get(row[0])?.albums.has(row[1])) albums.push(row)
    } else if (part.section === 'artistGenres' && intersects(part, initialIds)) {
      for (const row of await read(part) as typeof artists) if (initial.has(row[0])) artists.push(row)
    }
  }
  check()
  const ids = [...names.keys()].sort((a, b) => a - b)
  const remap = new Map(ids.map((id, index) => [id, index]))
  const projected: CompactGenreCatalogue = {
    schemaVersion: 2,
    artistNames: ids.map(id => names.get(id)!),
    genreNames,
    recordings: recordings.map(([artist, title, albums, genres]) => [remap.get(artist)!, title, albums, genres]),
    recordingAliases: aliases.map(([alias, credit]) => [remap.get(alias)!, remap.get(credit)!]),
    albumGenres: albums.map(([artist, album, genres]) => [remap.get(artist)!, album, genres]),
    artistGenres: artists.map(([artist, genres]) => [remap.get(artist)!, genres]),
  }
  return createCatalogueResolver(projected)
}

export function loadGenreCatalogue(plays: readonly Play[], options?: LoadOptions): Promise<GenreResolver> {
  return projectGenreCatalogue(bundle, plays, options)
}
