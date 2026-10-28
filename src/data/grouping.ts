import type { Play } from '../types'

export type GroupingMode = 'artist' | 'genre'
export interface GroupMember { name: string; weight: number }
export interface Grouping {
  mode: GroupingMode
  singular: string
  plural: string
  members: (play: Play) => readonly GroupMember[]
}
export const UNKNOWN_GENRE = 'Unknown genre'
export const ARTIST_GROUPING: Grouping = {
  mode: 'artist', singular: 'artist', plural: 'artists',
  members: play => [{ name: play.artist, weight: 1 }],
}

/** Group membership never changes song identity, timing or the number of starts. */
export function createGrouping(mode: GroupingMode, lookup: (play: Play) => readonly string[]): Grouping {
  if (mode === 'artist') return ARTIST_GROUPING
  const cache = new Map<string, readonly GroupMember[]>()
  return {
    mode, singular: 'genre', plural: 'genres',
    members(play) {
      if (play.kind !== 'track') return [{ name: play.artist, weight: 1 }]
      const key = JSON.stringify([play.uri, play.artist, play.title, play.album])
      let members = cache.get(key)
      if (!members) {
        const names = [...new Set(lookup(play))].filter(Boolean)
        members = names.length ? names.map(name => ({ name, weight: 1 / names.length })) : [{ name: UNKNOWN_GENRE, weight: 1 }]
        cache.set(key, members)
      }
      return members
    },
  }
}
