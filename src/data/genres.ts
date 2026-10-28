import { UNKNOWN_GENRE } from './grouping'
import type { Play } from '../types'
import { isSkip } from './stats'

export { createGenreLookup, createCatalogueLookup, createCatalogueResolver, genreCoverage } from './genreLookup'
export type { GenreRecording, CompactGenreCatalogue, GenreMatch, GenreResolver, GenreCoverage } from './genreLookup'
export type { CatalogueInfo } from './genreCatalogue'

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

export function genreStats(plays: readonly Play[], lookup: (play: Play) => readonly string[]) {
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
