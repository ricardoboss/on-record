import type { Play } from '../types'

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
  recordingAliases?: [alias: number, credit: number][]
  albumGenres?: [artist: number, album: string, genres: number[]][]
  artistGenres?: [artist: number, genres: number[]][]
}

export type GenreCatalogue = CompactGenreCatalogue | { schemaVersion?: 1; recordings: GenreRecording[] }

/** Preserve version markers and punctuation: guessing a remix is worse than an unknown. */
function normalize(value: string): string {
  return value.normalize('NFC').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2010-\u2015\u2212]/g, '-').trim().replace(/\s+/g, ' ').toLowerCase()
}
export { normalize as normalizeGenreName }

export type GenreSource = 'recording' | 'album' | 'artist' | 'unknown'
export type RecordingReason = 'matched' | 'artist-missing' | 'song-missing' | 'untagged' | 'conflicting' | 'not-music'
export interface GenreMatch {
  genres: readonly string[]
  source: GenreSource
  /** Explains why direct recording tags were unavailable, even when an estimate succeeds. */
  recordingReason: RecordingReason
}
export type GenreResolver = (play: Play, estimates?: boolean) => GenreMatch

function compare(a: string | number, b: string | number): number { return a < b ? -1 : a > b ? 1 : 0 }

function lowerBound<T>(rows: readonly T[], order: (row: T) => number): number {
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (order(rows[mid]) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function matching<T>(rows: readonly T[], order: (row: T) => number): T[] {
  const found: T[] = []
  for (let i = lowerBound(rows, order); i < rows.length && order(rows[i]) === 0; i++) found.push(rows[i])
  return found
}

/** No votes is different from a vote against a genre; neither resolves conflicting identities. */
function agree(sets: readonly (readonly string[])[]): readonly string[] {
  if (!sets.length) return []
  const first = [...new Set(sets[0])].sort()
  return sets.every(set => {
    const next = [...new Set(set)].sort()
    return next.length === first.length && next.every((value, i) => value === first[i])
  }) ? first : []
}

function compactLegacy(recordings: readonly GenreRecording[]): CompactGenreCatalogue {
  const artistNames = [...new Set(recordings.map(r => normalize(r.artist)))].sort()
  const genreNames = [...new Set(recordings.flatMap(r => r.genres.map(normalize).filter(Boolean)))].sort()
  const artists = new Map(artistNames.map((name, i) => [name, i]))
  const genres = new Map(genreNames.map((name, i) => [name, i]))
  const rows: CompactGenreCatalogue['recordings'] = recordings.map(r => [
    artists.get(normalize(r.artist))!, normalize(r.title), r.albums.map(normalize),
    [...new Set(r.genres.map(normalize).filter(Boolean).map(name => genres.get(name)!))],
  ])
  rows.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
  return { schemaVersion: 2, artistNames, genreNames, recordings: rows }
}

/** Sorted arrays keep the full catalogue out of a second large in-memory index. */
export function createCatalogueResolver(input: GenreCatalogue): GenreResolver {
  const catalogue = input.schemaVersion === 2 ? input : compactLegacy(input.recordings)
  const { artistNames, genreNames, recordings, recordingAliases = [], albumGenres = [], artistGenres = [] } = catalogue
  const cache = new Map<string, { direct: GenreMatch; estimated: GenreMatch }>()
  const names = (ids: readonly number[]) => ids.map(id => genreNames[id])
  return (play, estimates = true) => {
    if (play.kind !== 'track') return { genres: [], source: 'unknown', recordingReason: 'not-music' }
    const artist = normalize(play.artist), title = normalize(play.title), album = normalize(play.album)
    const key = JSON.stringify([artist, title, album])
    let result = cache.get(key)
    if (!result) {
      const artistIndex = lowerBound(artistNames, name => compare(name, artist))
      const knownArtist = artistNames[artistIndex] === artist
      const credits = knownArtist ? new Set([artistIndex, ...matching(recordingAliases, row => compare(row[0], artistIndex)).map(row => row[1])]) : new Set<number>()
      const candidates = [...credits].flatMap(credit => matching(recordings, row => compare(row[0], credit) || compare(row[1], title)))
      const exact = album ? candidates.filter(row => row[2].includes(album)) : []
      const chosen = exact.length ? exact : candidates
      const directTags = agree(chosen.map(row => names(row[3])))
      const recordingReason: RecordingReason = directTags.length ? 'matched' : !knownArtist ? 'artist-missing' : !chosen.length ? 'song-missing' : chosen.every(row => !row[3].length) ? 'untagged' : 'conflicting'
      const direct: GenreMatch = { genres: directTags, source: directTags.length ? 'recording' : 'unknown', recordingReason }
      let estimated = direct
      if (!directTags.length && knownArtist) {
        // Album tags describe this artist's specific album, never an unrelated namesake album.
        const albumTags = album ? agree(matching(albumGenres, row => compare(row[0], artistIndex) || compare(row[1], album)).map(row => names(row[2]))) : []
        const artistTags = albumTags.length ? [] : agree(matching(artistGenres, row => compare(row[0], artistIndex)).map(row => names(row[1])))
        if (albumTags.length) estimated = { genres: albumTags, source: 'album', recordingReason }
        else if (artistTags.length) estimated = { genres: artistTags, source: 'artist', recordingReason }
      }
      result = { direct, estimated }
      cache.set(key, result)
    }
    return estimates ? result.estimated : result.direct
  }
}

export function createCatalogueLookup(catalogue: GenreCatalogue) {
  const resolve = createCatalogueResolver(catalogue)
  return (play: Play): readonly string[] => resolve(play).genres
}

export function createGenreLookup(recordings: readonly GenreRecording[]) {
  return createCatalogueLookup({ recordings: [...recordings] })
}

export function genreCoverage(plays: readonly Play[], resolve: GenreResolver, estimates = true) {
  const sources: Record<GenreSource, { ms: number; starts: number; songs: number }> = {
    recording: { ms: 0, starts: 0, songs: 0 }, album: { ms: 0, starts: 0, songs: 0 },
    artist: { ms: 0, starts: 0, songs: 0 }, unknown: { ms: 0, starts: 0, songs: 0 },
  }
  const songs: Record<GenreSource, Set<string>> = { recording: new Set(), album: new Set(), artist: new Set(), unknown: new Set() }
  const reasons = new Map<RecordingReason, { ms: number; starts: number }>()
  const unmatched = new Map<string, { artist: string; title: string; album: string; ms: number; starts: number; reason: RecordingReason }>()
  for (const play of plays) {
    if (play.kind !== 'track') continue
    const match = resolve(play, estimates)
    const source = sources[match.source]
    source.ms += play.msPlayed
    source.starts++
    songs[match.source].add(JSON.stringify([play.artist, play.title, play.album]))
    if (match.source === 'unknown') {
      const reason = reasons.get(match.recordingReason) ?? { ms: 0, starts: 0 }
      reason.ms += play.msPlayed
      reason.starts++
      reasons.set(match.recordingReason, reason)
      const key = JSON.stringify([play.artist, play.title, play.album])
      const song = unmatched.get(key) ?? { artist: play.artist, title: play.title, album: play.album, ms: 0, starts: 0, reason: match.recordingReason }
      song.ms += play.msPlayed
      song.starts++
      unmatched.set(key, song)
    }
  }
  for (const source of Object.keys(sources) as GenreSource[]) sources[source].songs = songs[source].size
  return {
    sources,
    reasons: [...reasons].map(([reason, counts]) => ({ reason, ...counts })).sort((a, b) => b.ms - a.ms),
    unmatched: [...unmatched.values()].sort((a, b) => b.ms - a.ms).slice(0, 20),
  }
}
export type GenreCoverage = ReturnType<typeof genreCoverage>

