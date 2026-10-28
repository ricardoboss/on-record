import { describe, expect, it } from 'vitest'
import { daypartLeans } from '../../src/data/dayparts'
import { ARTIST_GROUPING, createGrouping, UNKNOWN_GENRE } from '../../src/data/grouping'
import { artistGraph, binArtistTotals, dailyTotals, dayDetail, dayparts, firstListens, hourProfile, makeBins, records, sessions, songStats } from '../../src/data/insights'
import { loveHate, tallyGroups } from '../../src/data/lovehate'
import { dayNumber, newArtistsIn, summarize, topItems } from '../../src/data/stats'
import { at, play, sorted } from '../helpers'

const grouping = createGrouping('genre', p => p.title === 'Both' ? ['rock', 'pop', 'rock'] : p.title === 'Jazz' ? ['jazz'] : [])
const plays = sorted([
  play(at(2024, 1, 1, 10), { title: 'Both', artist: 'Real artist', msPlayed: 120_000 }),
  play(at(2024, 1, 1, 11), { title: 'Both', artist: 'Real artist', msPlayed: 1_000, skipped: true }),
  play(at(2024, 1, 1, 12), { title: 'Unknown', msPlayed: 60_000 }),
])

describe('view grouping', () => {
  it('weights unique genres and retains unknown music and non-music identity', () => {
    expect(grouping.members(plays[0])).toEqual([{ name: 'rock', weight: 0.5 }, { name: 'pop', weight: 0.5 }])
    expect(grouping.members(plays[2])).toEqual([{ name: UNKNOWN_GENRE, weight: 1 }])
    expect(grouping.members(play(at(2024, 1, 1), { kind: 'episode', artist: 'Podcast' }))).toEqual([{ name: 'Podcast', weight: 1 }])
  })
  it('does not rewrite original plays or change listening totals, starts or song identity', () => {
    const before = structuredClone(plays)
    const original = summarize(plays)
    expect(summarize(plays, grouping)).toMatchObject({ ...original, artists: 2 })
    const ranked = topItems(plays, 'artist', 'time', Infinity, grouping)
    expect(ranked.reduce((n, r) => n + r.ms, 0)).toBe(original.musicMs)
    expect(ranked.reduce((n, r) => n + r.plays, 0)).toBe(original.streams)
    expect(topItems(plays, 'track', 'time', Infinity, grouping)).toEqual(topItems(plays, 'track', 'time', Infinity))
    expect(plays).toEqual(before)
  })
  it('keeps bin, hour and day totals while grouping their leading names', () => {
    const bins = makeBins(plays, 2024)
    expect(binArtistTotals(plays, bins, grouping).flatMap(m => [...m.values()]).reduce((a, b) => a + b, 0)).toBe(181_000)
    const hour = hourProfile(plays, grouping)[10]
    expect(hour).toMatchObject({ ms: 120_000, top: 'rock' })
    expect(dayparts(plays, grouping)[1]).toMatchObject({ artist: 'rock', ms: 60_500 })
    const day = dayNumber(at(2024, 1, 1))
    expect(dailyTotals(plays, grouping).get(day)).toMatchObject({ ms: 181_000, plays: 2, top: 'rock' })
    const detail = dayDetail(plays, day, firstListens(plays, grouping), grouping)
    expect(detail.artists.reduce((n, r) => n + r.ms, 0)).toBe(detail.ms)
    expect(detail.artists.reduce((n, r) => n + r.plays, 0)).toBe(detail.streams)
    expect(detail.plays).toEqual(plays)
    expect(detail.songs.find(s => s.title === 'Both')?.artist).toBe('Real artist')
  })
  it('uses original consecutive songs for graph links, never membership order', () => {
    const only = [play(at(2024, 1, 1), { title: 'Both' })]
    expect(artistGraph(only, 10, 3, grouping).links).toEqual([])
    const sequence = Array.from({ length: 8 }, (_, i) => play(at(2024, 1, 1, 12, i * 4), { title: i % 2 ? 'Jazz' : 'Both' }))
    const graph = artistGraph(sequence, 10, 3, grouping)
    expect(graph.links).toHaveLength(2)
    for (const link of graph.links) {
      expect([link.source, link.target]).toContain('jazz')
      expect(link.count).toBe(3.5)
    }
    expect(graph.nodes.reduce((n, r) => n + r.ms, 0)).toBe(sequence.length * 180_000)
  })
  it('counts first genre discoveries once across years, excluding unknowns', () => {
    const all = [...plays, play(at(2025, 1, 1), { title: 'Jazz' })]
    expect(newArtistsIn(all, 2024, grouping)).toBe(2)
    expect(newArtistsIn(all, 2025, grouping)).toBe(1)
    expect(firstListens(all, grouping).get('rock')).toBe(plays[0].endTime - plays[0].msPlayed)
  })
  it('includes short skips in genre scatter and head-to-head denominators', () => {
    const stats = songStats(plays, 10, grouping)
    expect(stats).toEqual([]) // A short sample stays below the scatter's floor.
    const tallies = tallyGroups(plays, grouping)
    expect(tallies.find(s => s.title === 'rock')).toMatchObject({ starts: 1, skips: 0.5, kept: 0.5, skipMedianMs: 1_000 })
    expect(tallies.reduce((n, r) => n + r.starts, 0)).toBe(plays.length)
    expect(tallies.reduce((n, r) => n + r.skips, 0)).toBe(1)
    const enough = Array.from({ length: 20 }, () => plays[0])
    expect(loveHate(enough, 2, grouping).loved[0].starts).toBe(10)
  })
  it('groups the phone clock without changing window totals', () => {
    const leans = daypartLeans(plays, grouping)
    expect(leans[0]).toMatchObject({ artist: 'pop', artistMs: 60_500, ms: 121_000, plays: 2 })
    expect(daypartLeans(plays, ARTIST_GROUPING)).toEqual(daypartLeans(plays))
  })
  it('compares genre skip rates even when every genre lies between song thresholds', () => {
    const members = createGrouping('genre', p => [p.title])
    const input = ['rock', 'pop'].flatMap((title, j) => Array.from({ length: 30 }, (_, i) =>
      play(at(2024, 1, 1), { title, skipped: i < (j ? 12 : 9) }),
    ))
    const pick = loveHate(input, 2, members)
    expect(pick.loved[0].title).toBe('rock')
    expect(pick.hated[0].title).toBe('pop')
    expect(pick.minStarts).toBe(20)
  })
  it('preserves artist-mode results for every aggregation', () => {
    const bins = makeBins(plays, 2024)
    expect(topItems(plays, 'artist', 'time', 10, ARTIST_GROUPING)).toEqual(topItems(plays, 'artist', 'time', 10))
    expect(binArtistTotals(plays, bins, ARTIST_GROUPING)).toEqual(binArtistTotals(plays, bins))
    expect(artistGraph(plays, 10, 3, ARTIST_GROUPING)).toEqual(artistGraph(plays, 10, 3))
    expect(hourProfile(plays, ARTIST_GROUPING)).toEqual(hourProfile(plays))
    expect(dailyTotals(plays, ARTIST_GROUPING)).toEqual(dailyTotals(plays))
    expect(records(plays, sessions(plays), ARTIST_GROUPING)).toEqual(records(plays, sessions(plays)))
    expect(loveHate(plays, 2, ARTIST_GROUPING)).toEqual(loveHate(plays))
  })
})
