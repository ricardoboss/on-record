import catalogue from './catalogue/genres.json'
import type { Play } from '../types'
import { isSkip } from './stats'

export interface GenreRecording {
  id: string
  artist: string
  title: string
  albums: string[]
  genres: string[]
}

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

export const lookupGenres = createGenreLookup(catalogue.recordings)

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
  for (const play of plays) {
    if (play.kind !== 'track') continue
    totalMs += play.msPlayed
    totalStarts++
    const genres = [...new Set(lookup(play))]
    if (!genres.length) continue
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
  return { genres, totalMs, matchedMs, unknownMs: totalMs - matchedMs, totalStarts, matchedStarts }
}
