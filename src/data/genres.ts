import { UNKNOWN_GENRE } from './grouping'
import catalogueText from './catalogue/genres.json?raw'
import type { Play } from '../types'
import { isSkip } from './stats'

export interface GenreRecording {
  id: string
  artist: string
  title: string
  albums: string[]
  genres: string[]
}

/** Dictionaries avoid repeating artist and genre names across a full bulk catalogue. */
export interface CompactGenreCatalogue {
  schemaVersion: 2
  artistNames: string[]
  genreNames: string[]
  /** Sorted by normalized artist index, then normalized title. */
  recordings: [artist: number, title: string, albums: string[], genres: number[]][]
}

type GenreCatalogue = CompactGenreCatalogue | { schemaVersion?: 1; recordings: GenreRecording[] }

/** Preserve version markers and punctuation: guessing a remix is worse than an unknown. */
function normalize(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function createGenreLookup(recordings: readonly GenreRecording[]) {
  const index = new Map<string, GenreRecording[]>()
  for (const recording of recordings) {
    const key = JSON.stringify([normalize(recording.artist), normalize(recording.title)])
    const group = index.get(key) ?? []
    group.push(recording)
    index.set(key, group)
  }
  return (play: Play): readonly string[] => {
    if (play.kind !== 'track') return []
    const key = JSON.stringify([normalize(play.artist), normalize(play.title)])
    const candidates = index.get(key) ?? []
    const exact = play.album ? candidates.filter(r => r.albums.some(a => normalize(a) === normalize(play.album))) : []
    const matches = exact.length ? exact : candidates
    // Multiple recordings can share a name. Only accept them if their genres agree.
    const choices = matches.map(r => [...new Set(r.genres.map(normalize).filter(Boolean))].sort())
    if (!choices.length || choices.some(g => JSON.stringify(g) !== JSON.stringify(choices[0]))) return []
    return choices[0]
  }
}

/**
 * A sorted compact catalogue needs no second, equally large Map index in the tab.
 * Only the few recordings matching the song are inspected for album conflicts.
 */
export function createCatalogueLookup(catalogue: GenreCatalogue): (play: Play) => readonly string[] {
  if (catalogue.schemaVersion !== 2) return createGenreLookup(catalogue.recordings)
  const { artistNames, genreNames, recordings } = catalogue
  return play => {
    if (play.kind !== 'track') return []
    const artist = normalize(play.artist)
    let lo = 0, hi = artistNames.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (artistNames[mid] < artist) lo = mid + 1
      else hi = mid
    }
    if (artistNames[lo] !== artist) return []
    const artistIndex = lo
    const title = normalize(play.title)
    lo = 0; hi = recordings.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const row = recordings[mid]
      if (row[0] < artistIndex || (row[0] === artistIndex && row[1] < title)) lo = mid + 1
      else hi = mid
    }
    const candidates: CompactGenreCatalogue['recordings'] = []
    for (let i = lo; i < recordings.length && recordings[i][0] === artistIndex && recordings[i][1] === title; i++) candidates.push(recordings[i])
    const album = normalize(play.album)
    const exact = album ? candidates.filter(row => row[2].includes(album)) : []
    const matches = exact.length ? exact : candidates
    let result: string[] | undefined
    for (const row of matches) {
      const genres = [...new Set(row[3].map(index => genreNames[index]))].sort()
      if (!result) result = genres
      else if (result.length !== genres.length || result.some((name, i) => name !== genres[i])) return []
    }
    return result ?? []
  }
}

// Importing as text keeps TypeScript from constructing types for millions of JSON tuples.
const catalogue = JSON.parse(catalogueText) as GenreCatalogue & { snapshot?: string; counts?: { recordings: number; artists: number; genres: number } }
export const lookupGenres = createCatalogueLookup(catalogue)
export const catalogueInfo = {
  snapshot: catalogue.snapshot,
  recordings: catalogue.counts?.recordings ?? catalogue.recordings.length,
  artists: catalogue.counts?.artists ?? (catalogue.schemaVersion === 2 ? catalogue.artistNames.length : new Set(catalogue.recordings.map(r => r.artist)).size),
  genres: catalogue.counts?.genres ?? (catalogue.schemaVersion === 2 ? catalogue.genreNames.length : new Set(catalogue.recordings.flatMap(r => r.genres)).size),
}

export interface GenreStat {
  genre: string
  ms: number
  /** Fractional starts keep multi-genre songs from being counted twice. */
  starts: number
  skips: number
  skipRate: number
  tracks: number
  artists: number
}

export function genreStats(plays: readonly Play[], lookup = lookupGenres) {
  const groups = new Map<string, { stat: GenreStat; tracks: Set<string>; artists: Set<string> }>()
  let totalMs = 0, matchedMs = 0, totalStarts = 0, matchedStarts = 0
  const unknownTracks = new Set<string>(), unknownArtists = new Set<string>()
  const unknown: GenreStat = { genre: UNKNOWN_GENRE, ms: 0, starts: 0, skips: 0, skipRate: 0, tracks: 0, artists: 0 }
  for (const play of plays) {
    if (play.kind !== 'track') continue
    totalMs += play.msPlayed
    totalStarts++
    const genres = [...new Set(lookup(play))]
    if (!genres.length) {
      unknown.ms += play.msPlayed
      unknown.starts++
      if (isSkip(play)) unknown.skips++
      unknownTracks.add(play.uri || JSON.stringify([play.artist, play.title, play.album]))
      unknownArtists.add(play.artist)
      continue
    }
    matchedMs += play.msPlayed
    matchedStarts++
    const weight = 1 / genres.length
    const track = play.uri || JSON.stringify([play.artist, play.title, play.album])
    for (const genre of genres) {
      let group = groups.get(genre)
      if (!group) {
        group = { stat: { genre, ms: 0, starts: 0, skips: 0, skipRate: 0, tracks: 0, artists: 0 }, tracks: new Set(), artists: new Set() }
        groups.set(genre, group)
      }
      group.stat.ms += play.msPlayed * weight
      group.stat.starts += weight
      if (isSkip(play)) group.stat.skips += weight
      group.tracks.add(track)
      group.artists.add(play.artist)
    }
  }
  const genres = [...groups.values()].map(({ stat, tracks, artists }) => ({
    ...stat, skipRate: stat.starts ? stat.skips / stat.starts : 0, tracks: tracks.size, artists: artists.size,
  })).sort((a, b) => b.ms - a.ms || a.genre.localeCompare(b.genre))
  unknown.skipRate = unknown.starts ? unknown.skips / unknown.starts : 0
  unknown.tracks = unknownTracks.size
  unknown.artists = unknownArtists.size
  return { genres, unknown, totalMs, matchedMs, unknownMs: totalMs - matchedMs, totalStarts, matchedStarts }
}
