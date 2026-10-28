import { useContext, useMemo, useRef, useState } from 'react'
import type { genreStats } from '../data/genres'
import { formatDuration, formatNumber, formatPercent } from '../lib/format'
import { useSize } from '../lib/hooks'
import { SERIES } from '../lib/palette'
import { InCards } from '../lib/stage'
import { Segmented } from './ui'

/*
 * "Genres": what your listening is made of, ranked. Bars are your time per
 * genre, or how often you skip it. Genres come from a catalogue bundled with the
 * app, which doesn't know every song, so what it doesn't know is counted and
 * said out loud instead of being quietly dropped from the ranking.
 */

export type GenreStats = ReturnType<typeof genreStats>
type Mode = 'time' | 'skips'

/** The same colors LoveHate gives to listening and skipping */
const BAR = { time: SERIES[1], skips: SERIES[2] }

/** A skip rate off a handful of starts is noise: a genre needs this many to be ranked by it */
const MIN_STARTS = 20

const PAGE_ROWS = 12
/** Height of one row on a card: the name over its bar, plus the gap to the next */
const CARD_ROW = 40

/** A share that never rounds into something it isn't: 0% only for none, 100% only for all */
function share(fraction: number): string {
  if (fraction > 0 && fraction < 0.005) return '<1%'
  if (fraction < 1 && fraction >= 0.995) return '>99%'
  return formatPercent(fraction)
}

export function Genres({ stats }: { stats: GenreStats }) {
  const cards = useContext(InCards)
  const [mode, setMode] = useState<Mode>('time')
  const listRef = useRef<HTMLDivElement>(null)
  const { height } = useSize(listRef, { width: 0, height: PAGE_ROWS * CARD_ROW }, cards)
  const fit = cards ? Math.max(1, Math.floor(height / CARD_ROW)) : PAGE_ROWS

  const ranked = useMemo(
    () =>
      mode === 'time'
        ? [...stats.genres].sort((a, b) => b.ms - a.ms)
        : stats.genres.filter((g) => g.starts >= MIN_STARTS).sort((a, b) => b.skipRate - a.skipRate || b.starts - a.starts),
    [stats, mode],
  )
  const overall = useMemo(() => {
    const starts = stats.genres.reduce((sum, g) => sum + g.starts, 0)
    return starts === 0 ? 0 : stats.genres.reduce((sum, g) => sum + g.skips, 0) / starts
  }, [stats])

  if (stats.totalStarts === 0) return <p className="empty">There’s no music in this period to sort into genres.</p>
  if (stats.matchedStarts === 0) {
    return <p className="empty">None of these songs are in the genre catalogue, so there’s nothing to rank. Try another period.</p>
  }

  const rows = ranked.slice(0, fit)
  const top = ranked[0]
  const scale = mode === 'time' ? top?.ms : top?.skipRate

  // Coverage speaks the language of the bars: time for time, starts for skip rates
  const known = mode === 'time' ? (stats.totalMs ? stats.matchedMs / stats.totalMs : 0) : stats.totalStarts === 0 ? 0 : stats.matchedStarts / stats.totalStarts
  const unknownText =
    mode === 'time' ? formatDuration(stats.unknownMs) : `${formatNumber(stats.totalStarts - stats.matchedStarts)} starts`

  return (
    <div className={cards ? 'genres genres--card' : 'genres'}>
      <Segmented
        className="genres__mode"
        label="Rank genres by"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'time', label: 'Listening time' },
          { value: 'skips', label: 'Skip rate' },
        ]}
      />

      {!cards && top && (
        <p className="guide__takeaway">
          {mode === 'time' ? (
            <>
              <em>{top.genre}</em> takes the biggest share: {share(stats.totalMs ? top.ms / stats.totalMs : 0)} of your listening time.
            </>
          ) : (
            <>
              You skip <em>{top.genre}</em> the most: {share(top.skipRate)} of {formatNumber(top.starts)} weighted starts, against {share(overall)} across all genres.
            </>
          )}
        </p>
      )}

      <div className="genres__coverage">
        <div className="genres__coverbar" aria-hidden="true">
          <i style={{ flexGrow: known, background: BAR[mode] }} />
          <i style={{ flexGrow: 1 - known }} />
        </div>
        <p>
          <b>{share(known)}</b> of your {mode === 'time' ? 'listening time' : 'starts'} has a genre.{known < 1 && <> The rest ({unknownText}) isn’t in the catalogue and is left out.</>}
        </p>
      </div>

      <div className="genres__listbox" ref={listRef}>
        {rows.length > 0 ? (
          <ol className="genres__list" aria-label={mode === 'time' ? 'Genres by listening time' : 'Genres by skip rate'}>
            {rows.map((g) => (
              <li key={g.genre} className="genres__row">
                <span className="genres__name">{g.genre}</span>
                <span className="genres__value">
                  <b>{mode === 'time' ? share(stats.totalMs ? g.ms / stats.totalMs : 0) : share(g.skipRate)}</b>
                  <span>{mode === 'time' ? formatDuration(g.ms) : `of ${formatNumber(g.starts)} weighted starts`}</span>
                </span>
                <span className="genres__track" aria-hidden="true">
                  <i style={{ width: `${scale ? ((mode === 'time' ? g.ms : g.skipRate) / scale) * 100 : 0}%`, background: BAR[mode] }} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="genres__none">No genre has {MIN_STARTS} starts yet, so there’s no skip rate to trust. Pick a longer period.</p>
        )}
      </div>

      {(mode === 'skips' || ranked.length > rows.length) && (
        <p className="genres__foot">
          {mode === 'skips' && `Genres with fewer than ${MIN_STARTS} weighted starts aren’t ranked. `}
          {ranked.length > rows.length && `Showing ${rows.length} of ${ranked.length}.`}
        </p>
      )}
    </div>
  )
}

export function GenresTable({ stats }: { stats: GenreStats }) {
  const ranked = [...stats.genres].sort((a, b) => b.ms - a.ms)
  return (
    <table>
      <thead>
        <tr>
          <th>Genre</th>
          <th className="num">Share</th>
          <th className="num">Time</th>
          <th className="num">Weighted starts</th>
          <th className="num">Skipped</th>
          <th className="num">Songs</th>
          <th className="num">Artists</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((g) => (
          <tr key={g.genre}>
            <td>{g.genre}</td>
            <td className="num">{share(stats.totalMs === 0 ? 0 : g.ms / stats.totalMs)}</td>
            <td className="num">{formatDuration(g.ms)}</td>
            <td className="num">{formatNumber(g.starts)}</td>
            {/* Too few starts to say: a dash, not a percentage that looks like a finding */}
            <td className="num">{g.starts >= MIN_STARTS ? share(g.skipRate) : '–'}</td>
            <td className="num">{formatNumber(g.tracks)}</td>
            <td className="num">{formatNumber(g.artists)}</td>
          </tr>
        ))}
        <tr>
          <td>No genre known</td>
          <td className="num">{share(stats.totalMs === 0 ? 0 : stats.unknownMs / stats.totalMs)}</td>
          <td className="num">{formatDuration(stats.unknownMs)}</td>
          <td className="num">{formatNumber(stats.totalStarts - stats.matchedStarts)}</td>
          <td className="num">–</td>
          <td className="num">–</td>
          <td className="num">–</td>
        </tr>
      </tbody>
    </table>
  )
}
