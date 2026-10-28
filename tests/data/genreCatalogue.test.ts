import { describe, expect, it, vi } from 'vitest'
import { projectGenreCatalogue } from '../../src/data/genreCatalogue'
import type { CatalogueBundle, CataloguePart, CatalogueSection } from '../../src/data/genreCatalogue'
import { createCatalogueResolver } from '../../src/data/genreLookup'
import type { CompactGenreCatalogue } from '../../src/data/genreLookup'
import { at, play } from '../helpers'

const start = at(2024, 1, 1)
const catalogue: CompactGenreCatalogue = {
  schemaVersion: 2,
  artistNames: ['artist', 'artist alias', 'artist credit', 'fallback only', 'homonym', 'other', 'untagged', 'zzz unrelated'],
  genreNames: ['jazz', 'pop', 'rock'],
  recordings: [
    [2, 'clash', ['one'], [0]], [2, 'clash', ['two'], [2]],
    [2, "it's - live", [], [0]],
    [2, 'mixed', ['album'], [1]], [2, 'mixed', ['alternate'], []],
    [2, 'song', ['album'], [2]], [2, 'song - live', ['live'], [0]],
    [2, 'unused', ['unused album'], [2]],
    [5, 'unrelated title', ['unrelated album'], [2]],
    [6, 'untagged', ['album'], []],
    [7, 'never', ['discard'], [2]],
  ],
  recordingAliases: [[0, 2], [1, 2], [7, 5]],
  albumGenres: [
    [0, 'album', [1]], [0, 'ambiguous', [0]], [0, 'ambiguous', [2]],
    [0, 'untagged', []], [0, 'untagged', [1]], [0, 'unused album', [2]],
    [1, 'album', [1]], [3, 'only album', [2]], [5, 'unrelated album', [0]], [7, 'discard', [2]],
  ],
  artistGenres: [[0, [0]], [1, [0]], [3, [1]], [4, [0]], [4, [2]], [5, [0]], [7, [1]]],
}

function fixture() {
  const loads = new Map<string, ReturnType<typeof vi.fn>>()
  function part(section: CatalogueSection, rows: unknown[], label: string, start?: number): CataloguePart {
    const load = vi.fn(async () => ({ section, rows }))
    loads.set(label, load)
    if (section === 'artistNames') return { section, start, min: start, max: start! + rows.length - 1, first: rows[0] as string, last: rows.at(-1) as string, load }
    const first = rows[0] as unknown[] | undefined, last = rows.at(-1) as unknown[] | undefined
    return { section, min: first?.[0] as number | undefined, max: last?.[0] as number | undefined, load }
  }
  const parts: CataloguePart[] = [part('genreNames', catalogue.genreNames, 'genres')]
  for (let i = 0; i < catalogue.artistNames.length; i++) parts.push(part('artistNames', [catalogue.artistNames[i]], 'names-' + i, i))
  parts.push(
    part('recordingAliases', catalogue.recordingAliases!.slice(0, 2), 'aliases'),
    part('recordingAliases', catalogue.recordingAliases!.slice(2), 'unrelated-aliases'),
    part('recordings', catalogue.recordings.filter(row => row[0] === 2), 'recordings'),
    part('recordings', catalogue.recordings.filter(row => row[0] === 5), 'unrelated-recordings'),
    part('recordings', catalogue.recordings.filter(row => row[0] === 6), 'untagged-recordings'),
    part('recordings', catalogue.recordings.filter(row => row[0] === 7), 'discarded-recordings'),
    part('albumGenres', catalogue.albumGenres!.filter(row => row[0] < 5), 'albums'),
    part('albumGenres', catalogue.albumGenres!.filter(row => row[0] >= 5), 'unrelated-albums'),
    part('artistGenres', catalogue.artistGenres!.filter(row => row[0] < 5), 'artists'),
    part('artistGenres', catalogue.artistGenres!.filter(row => row[0] >= 5), 'unrelated-artists'),
  )
  return { source: { metadata: { schemaVersion: 2 }, parts } satisfies CatalogueBundle, loads }
}

describe('selective genre catalogue loading', () => {
  it('releases session payloads after success and after a canceled preparation', async () => {
    const { source } = fixture()
    const release = vi.fn()
    const session: CatalogueBundle = { ...source, release }
    const root: CatalogueBundle = { metadata: source.metadata, parts: [], createSession: () => session }
    const song = play(start)
    expect((await projectGenreCatalogue(root, [song]))(song).source).toBe('recording')
    expect(release).toHaveBeenCalledTimes(1)
    release.mockClear()
    const controller = new AbortController()
    session.prepare = async () => controller.abort()
    await expect(projectGenreCatalogue(root, [song], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(release).toHaveBeenCalled()
  })
  it('prepares public payloads before inspecting history-dependent chunks', async () => {
    const { source } = fixture()
    let prepared = false
    for (const part of source.parts) {
      const load = part.load
      part.load = async () => { expect(prepared).toBe(true); return load() }
    }
    const prepare = vi.fn(async (onProgress?: (count: number) => void) => { onProgress?.(4); prepared = true })
    const counts: number[] = []
    const resolver = await projectGenreCatalogue({ ...source, prepare }, [play(start)], { onProgress: count => counts.push(count) })
    expect(resolver(play(start)).source).toBe('recording')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls[0]).toHaveLength(1)
    expect(typeof prepare.mock.calls[0][0]).toBe('function')
    expect(counts[0]).toBe(4)
    expect(counts[1]).toBe(5)
  })

  it('matches the full catalogue for all supplied songs with estimates enabled or disabled', async () => {
    const { source } = fixture()
    const plays = [
      play(start), play(start, { artist: 'Artist Alias' }),
      play(start, { title: 'Unlisted' }), play(start, { title: 'Other', album: '' }),
      play(start, { title: 'Clash', album: 'One' }), play(start, { title: 'Clash', album: '' }),
      play(start, { title: 'Mixed', album: 'Album' }), play(start, { title: 'Mixed', album: '' }),
      play(start, { title: 'Song - Live', album: 'Live' }), play(start, { title: 'Song - Remix' }),
      play(start, { title: 'Other', album: 'Ambiguous' }), play(start, { title: 'Other', album: 'Untagged' }),
      play(start, { artist: ' ARTIST ', title: 'It’s – Live' }),
      play(start, { artist: 'Fallback Only', title: 'Other', album: 'Only Album' }),
      play(start, { artist: 'Fallback Only', title: 'Other', album: '' }),
      play(start, { artist: 'Homonym', title: 'Other', album: '' }),
      play(start, { artist: 'Untagged', title: 'Untagged' }),
      play(start, { artist: 'Absent' }), play(start, { kind: 'episode' }),
    ]
    const projected = await projectGenreCatalogue(source, plays)
    const full = createCatalogueResolver(catalogue)
    for (const estimates of [false, true]) for (const song of plays) expect(projected(song, estimates)).toEqual(full(song, estimates))
  })

  it('loads alias target names outside the requested-name ranges and skips unrelated chunks', async () => {
    const { source, loads } = fixture()
    const song = play(start)
    const projected = await projectGenreCatalogue(source, [song])
    expect(projected(song)).toMatchObject({ genres: ['rock'], source: 'recording' })
    expect(loads.get('names-2')).toHaveBeenCalledTimes(1)
    expect(loads.get('aliases')).toHaveBeenCalledTimes(1)
    for (const label of ['names-1', 'names-5', 'names-6', 'names-7', 'unrelated-aliases', 'unrelated-recordings', 'untagged-recordings', 'discarded-recordings', 'unrelated-albums', 'unrelated-artists']) {
      expect(loads.get(label), label).not.toHaveBeenCalled()
    }
    // The input history defines the projection; an unplayed title is not retained.
    const unplayed = play(start, { title: 'Unused', album: 'Unused Album' })
    expect(createCatalogueResolver(catalogue)(unplayed, false).source).toBe('recording')
    expect(projected(unplayed, false).source).toBe('unknown')
    expect(projected(play(start, { title: 'Unlisted', album: 'Unused Album' })).source).toBe('artist')
  })

  it('prepares all history years together so later filters can reuse the resolver', async () => {
    const { source } = fixture()
    const first = play(at(2020, 1, 1)), later = play(at(2026, 1, 1), { artist: 'Fallback Only', album: 'Only Album' })
    const resolver = await projectGenreCatalogue(source, [first, later])
    expect(resolver(first)).toMatchObject({ source: 'recording', genres: ['rock'] })
    expect(resolver(later)).toMatchObject({ source: 'album', genres: ['rock'] })
  })

  it('supports the small legacy snapshot', async () => {
    const source: CatalogueBundle = {
      metadata: { schemaVersion: 1 },
      parts: [{ section: 'recordings', load: async () => ({ section: 'recordings', rows: [{ id: 'one', artist: 'Artist', title: 'Song', albums: ['Album'], genres: ['rock'] }] }) }],
    }
    expect((await projectGenreCatalogue(source, [play(start)]))(play(start))).toMatchObject({ source: 'recording', genres: ['rock'] })
  })

  it('does not load catalogue chunks for a history without music', async () => {
    const { source, loads } = fixture()
    const podcast = play(start, { kind: 'episode' })
    const resolver = await projectGenreCatalogue(source, [podcast])
    expect(resolver(podcast)).toMatchObject({ source: 'unknown', recordingReason: 'not-music' })
    for (const load of loads.values()) expect(load).not.toHaveBeenCalled()
  })

  it('rejects cancellation before and during loading without returning partial matches', async () => {
    const controller = new AbortController()
    controller.abort()
    const before = fixture()
    await expect(projectGenreCatalogue(before.source, [play(start)], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    for (const load of before.loads.values()) expect(load).not.toHaveBeenCalled()
    const during = fixture(), cancellation = new AbortController()
    const progress: number[] = []
    await expect(projectGenreCatalogue(during.source, [play(start)], {
      signal: cancellation.signal,
      onProgress: count => { progress.push(count); if (count === 2) cancellation.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toEqual([1, 2])
    expect(during.loads.get('recordings')).not.toHaveBeenCalled()
  })

  it('preserves untagged ambiguity when one title crosses catalogue chunk boundaries', async () => {
    const { source } = fixture()
    const original = source.parts.find(part => part.section === 'recordings')!
    const rows = catalogue.recordings.filter(row => row[0] === 2 && row[1] === 'mixed')
    source.parts = source.parts.flatMap(part => part === original ? rows.map(row => ({ section: 'recordings' as const, min: 2, max: 2, load: async () => ({ section: 'recordings', rows: [row] }) })) : [part])
    const song = play(start, { title: 'Mixed', album: '' })
    const resolver = await projectGenreCatalogue(source, [song])
    expect(resolver(song, false)).toEqual(createCatalogueResolver(catalogue)(song, false))
    expect(resolver(song, false)).toMatchObject({ source: 'unknown', recordingReason: 'conflicting' })
  })
})
