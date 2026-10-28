import { describe, expect, it } from 'vitest'
import { createGenreLookup, genreStats } from '../../src/data/genres'
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
