import { describe, expect, it } from 'vitest'
import { createCatalogueLookup, createCatalogueResolver, createGenreLookup, genreCoverage, genreStats } from '../../src/data/genres'
import { generateSampleGenreMap } from '../../src/data/sample'
import { at, play } from '../helpers'

const recording = { id: 'one', artist: 'Artist', title: 'Song', albums: ['Album'], genres: ['rock', 'pop'] }
const lookup = createGenreLookup([recording])
const start = at(2024, 1, 1)

describe('offline genre matching', () => {
  it('normalizes case, whitespace and Unicode without dropping version markers', () => {
    expect(lookup(play(start, { artist: ' ARTIST ', title: 'song' }))).toEqual(['pop', 'rock'])
    expect(lookup(play(start, { title: 'Song - Live' }))).toEqual([])
    expect(lookup(play(start, { artist: 'Other artist' }))).toEqual([])
  })
  it('uses the album to disambiguate conflicting recordings, otherwise leaves them unknown', () => {
    const ambiguous = createGenreLookup([recording, { ...recording, id: 'two', albums: ['Live'], genres: ['jazz'] }])
    expect(ambiguous(play(start))).toEqual(['pop', 'rock'])
    expect(ambiguous(play(start, { album: 'Live' }))).toEqual(['jazz'])
    expect(ambiguous(play(start, { album: '' }))).toEqual([])
  })
  it('does not match non-music', () => {
    expect(lookup(play(start, { kind: 'episode' }))).toEqual([])
  })
})

describe('genre estimates and diagnostics', () => {
  const resolve = createCatalogueResolver({
    schemaVersion: 2,
    artistNames: ['artist', 'artist & guest', 'artist alias', 'fallback only', 'homonym'],
    genreNames: ['jazz', 'pop', 'rock'],
    recordings: [
      [1, 'song', ['album'], [2]],
      [1, 'song - live', ['live'], [0]],
    ],
    recordingAliases: [[0, 1], [2, 1]],
    albumGenres: [[0, 'album', [1]], [0, 'ambiguous', [0]], [0, 'ambiguous', [2]], [0, 'untagged', []], [0, 'untagged', [1]], [3, 'only album', [2]]],
    artistGenres: [[0, [0]], [2, [0]], [3, [1]], [4, [0]], [4, [2]]],
  })
  it('uses direct recording tags before album and artist estimates, including primary credits and aliases', () => {
    expect(resolve(play(start))).toMatchObject({ source: 'recording', genres: ['rock'] })
    expect(resolve(play(start, { artist: 'Artist Alias' }))).toMatchObject({ source: 'recording', genres: ['rock'] })
    expect(resolve(play(start, { title: 'Unlisted' }))).toMatchObject({ source: 'album', genres: ['pop'], recordingReason: 'song-missing' })
    expect(resolve(play(start, { title: 'Unlisted', album: 'Other album' }))).toMatchObject({ source: 'artist', genres: ['jazz'] })
  })
  it('uses fallback-only artists and albums even without any recording entries', () => {
    expect(resolve(play(start, { artist: 'Fallback Only', album: 'Only Album' }))).toMatchObject({ source: 'album', genres: ['rock'] })
    expect(resolve(play(start, { artist: 'Fallback Only', album: '' }))).toMatchObject({ source: 'artist', genres: ['pop'] })
    expect(resolve(play(start, { artist: 'Absent' }))).toMatchObject({ source: 'unknown', recordingReason: 'artist-missing' })
  })
  it('can disable all estimates without caching an estimated result as a direct tag', () => {
    const song = play(start, { title: 'Unlisted' })
    expect(resolve(song).source).toBe('album')
    expect(resolve(song, false)).toMatchObject({ genres: [], source: 'unknown', recordingReason: 'song-missing' })
    expect(resolve(song).source).toBe('album')
    expect(resolve(play(start), false).source).toBe('recording')
  })
  it('keeps conflicting album/artist identities conservative and never crosses artist boundaries', () => {
    expect(resolve(play(start, { title: 'Unlisted', album: 'Ambiguous' })).source).toBe('artist')
    expect(resolve(play(start, { title: 'Unlisted', album: 'Untagged' })).source).toBe('artist')
    expect(resolve(play(start, { artist: 'Homonym' })).source).toBe('unknown')
    expect(resolve(play(start, { artist: 'Artist Alias', title: 'Unlisted' })).source).toBe('artist')
  })
  it('preserves remix/live markers and excludes podcasts from estimates', () => {
    expect(resolve(play(start, { title: 'Song - Live', album: 'Live' }))).toMatchObject({ source: 'recording', genres: ['jazz'] })
    expect(resolve(play(start, { title: 'Song - Remix' })).source).toBe('album')
    expect(resolve(play(start, { kind: 'episode' }))).toMatchObject({ source: 'unknown', genres: [], recordingReason: 'not-music' })
  })
  it('normalizes typographic quotes and dashes without removing version words', () => {
    const lookup = createGenreLookup([{ ...recording, title: 'It’s a Song – Live' }])
    expect(lookup(play(start, { title: "It's a Song - Live" }))).toEqual(['pop', 'rock'])
    expect(lookup(play(start, { title: "It's a Song" }))).toEqual([])
  })
  it('counts every start and millisecond once and lists unknown reasons without private export fields', () => {
    const plays = [play(start), play(start, { title: 'Unlisted' }), play(start, { title: 'Other', album: '' }), play(start, { artist: 'Absent' }), play(start, { artist: 'Absent' }), play(start, { kind: 'episode' })]
    const coverage = genreCoverage(plays, resolve)
    expect(coverage.sources).toMatchObject({ recording: { starts: 1 }, album: { starts: 1 }, artist: { starts: 1 }, unknown: { starts: 2, songs: 1 } })
    expect(Object.values(coverage.sources).reduce((sum, row) => sum + row.ms, 0)).toBe(5 * 180000)
    expect(coverage.reasons).toEqual([{ reason: 'artist-missing', starts: 2, ms: 360000 }])
    expect(coverage.unmatched).toEqual([{ artist: 'Absent', title: 'Song', album: 'Album', ms: 360000, starts: 2, reason: 'artist-missing' }])
    expect(genreCoverage(plays, resolve, false).sources.unknown.starts).toBe(4)
    const stats = genreStats(plays, p => resolve(p).genres)
    expect(stats.matchedStarts).toBe(3)
    expect(stats.genres.reduce((sum, row) => sum + row.ms, 0) + stats.unknownMs).toBe(stats.totalMs)
  })
})

describe('genreStats', () => {
  it('splits time and starts evenly, preserves short skips, and counts distinct songs/artists', () => {
    const result = genreStats([play(start, { msPlayed: 120000 }), play(start, { msPlayed: 1000, reasonEnd: 'fwdbtn' })], lookup)
    expect(result.totalStarts).toBe(2)
    expect(result.matchedMs).toBe(121000)
    expect(result.genres).toHaveLength(2)
    for (const genre of result.genres) {
      expect(genre).toMatchObject({ ms: 60500, starts: 1, skips: 0.5, skipRate: 0.5, tracks: 1, artists: 1 })
    }
    expect(result.genres.reduce((sum, g) => sum + g.ms, 0)).toBe(result.matchedMs)
    expect(result.genres.reduce((sum, g) => sum + g.starts, 0)).toBe(result.matchedStarts)
  })
  it('keeps unknown music in coverage and excludes podcasts', () => {
    const result = genreStats([play(start), play(start, { title: 'Unknown' }), play(start, { kind: 'episode' })], lookup)
    expect(result).toMatchObject({ totalMs: 360000, matchedMs: 180000, unknownMs: 180000, totalStarts: 2, matchedStarts: 1 })
  })
  it('retains unknown music as a measurable group without claiming metadata coverage', () => {
    const result = genreStats([play(start, { title: 'Unknown', skipped: true })], lookup)
    expect(result.matchedStarts).toBe(0)
    expect(result.unknown).toMatchObject({ genre: 'Unknown genre', starts: 1, skips: 1, skipRate: 1, tracks: 1, artists: 1 })
    expect(result.unknown.ms).toBe(result.totalMs)
  })
  it('handles zero-duration starts and empty histories without NaN', () => {
    expect(genreStats([], lookup)).toMatchObject({ genres: [], totalMs: 0, matchedMs: 0, totalStarts: 0 })
    const result = genreStats([play(start, { msPlayed: 0, skipped: true })], lookup)
    expect(result.matchedStarts).toBe(1)
    expect(result.genres[0].skipRate).toBe(1)
  })
  it('deduplicates genre labels', () => {
    const result = genreStats([play(start)], () => ['rock', 'rock'])
    expect(result.genres[0].starts).toBe(1)
  })
  it('provides deterministic genres for invented sample songs', () => {
    const first = generateSampleGenreMap()
    expect(first.size).toBeGreaterThan(100)
    expect(first).toEqual(generateSampleGenreMap())
    expect(first.get('spotify:track:sample0x0')).toEqual(['indie rock'])
  })
})

// The compact bulk format uses the same conservative matching rules as the small snapshot.
describe('bulk catalogue lookup', () => {
  const compact = createCatalogueLookup({
    schemaVersion: 2,
    artistNames: ['another artist', 'artist', '𐀀 artist'],
    genreNames: ['jazz', 'pop', 'rock'],
    recordings: [
      [0, 'song', ['album'], [0]],
      [1, 'conflict', ['one'], [0]],
      [1, 'conflict', ['two'], [2]],
      [1, 'song', ['album'], [1, 2]],
      [1, 'song', ['reissue'], [2, 1]],
      [1, 'untagged conflict', ['album'], [1]],
      [1, 'untagged conflict', ['other album'], []],
      [2, '𐀀 song', [], [2]],
    ],
  })
  it('finds artists and titles by binary search, keeping aliases and versions conservative', () => {
    expect(compact(play(start, { artist: ' ARTIST ', title: ' Song ' }))).toEqual(['pop', 'rock'])
    expect(compact(play(start, { artist: 'Another artist' }))).toEqual(['jazz'])
    expect(compact(play(start, { artist: 'Not in catalogue' }))).toEqual([])
    expect(compact(play(start, { title: 'Song - Live' }))).toEqual([])
    expect(compact(play(start, { kind: 'episode' }))).toEqual([])
    expect(compact(play(start, { artist: '𐀀 artist', title: '𐀀 song' }))).toEqual(['rock'])
  })
  it('resolves albums while leaving conflicting and untagged candidates unknown', () => {
    expect(compact(play(start, { title: 'Conflict', album: 'one' }))).toEqual(['jazz'])
    expect(compact(play(start, { title: 'Conflict', album: '' }))).toEqual([])
    expect(compact(play(start, { title: 'Untagged conflict', album: 'album' }))).toEqual(['pop'])
    expect(compact(play(start, { title: 'Untagged conflict', album: '' }))).toEqual([])
  })
})
