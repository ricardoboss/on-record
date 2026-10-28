import type { CatalogueInfo, GenreCoverage } from '../data/genres'
import type { RecordingReason } from '../data/genreLookup'
import { useCloseOnBack } from '../lib/back'
import { formatDuration, formatNumber, formatPercent } from '../lib/format'
import { Modal, ModalHead } from './Panels'

const REASONS: Record<RecordingReason, string> = {
  matched: 'Recording tags found',
  'artist-missing': 'No artist-name match in the catalogue',
  'song-missing': 'No tagged recording-name match',
  untagged: 'Matching recording has no genre tags',
  conflicting: 'Matching recordings disagree or include untagged candidates',
  'not-music': 'Not music',
}
const SOURCES = [['recording', 'Song tags'], ['album', 'Album estimate'], ['artist', 'Artist estimate'], ['unknown', 'Unknown']] as const

export function GenreCoveragePanel({ open, onClose, coverage, catalogue }: { open: boolean; onClose: () => void; coverage: GenreCoverage; catalogue?: CatalogueInfo }) {
  useCloseOnBack(open, onClose)
  const total = Object.values(coverage.sources).reduce((sum, source) => sum + source.ms, 0)
  return (
    <Modal open={open} onClose={onClose} label="Genre coverage" className="modal--panel genre-details">
      <ModalHead title="Genre coverage" onClose={onClose} />
      <p className="settings__note">For the selected year and filters. Album and artist genres are estimates of a song’s genre. Settings lets you turn them off for every view and export.</p>
      <table>
        <thead><tr><th>Source</th><th className="num">Time</th><th className="num">Share</th><th className="num">Songs</th></tr></thead>
        <tbody>{SOURCES.map(([key, label]) => {
          const source = coverage.sources[key]
          return <tr key={key}><td>{label}</td><td className="num">{formatDuration(source.ms)}</td><td className="num">{formatPercent(total ? source.ms / total : 0)}</td><td className="num">{formatNumber(source.songs)}</td></tr>
        })}</tbody>
      </table>
      <p className="settings__note">A song can appear under more than one source if its export metadata differs. Time and starts are counted once. Artist-name matching uses credited names and unambiguous aliases; live and remix markers are kept.</p>
      {coverage.reasons.length > 0 && <>
        <h3>Why songs remain unknown</h3>
        <ul>{coverage.reasons.map(row => <li key={row.reason}>{REASONS[row.reason]}: {formatDuration(row.ms)} ({formatNumber(row.starts)} starts).</li>)}</ul>
        <h3>Most listening time without a genre</h3>
        <ol className="genre-details__songs">{coverage.unmatched.map(song => <li key={JSON.stringify([song.artist, song.title, song.album])}>
          <strong>{song.title}</strong><span>{song.artist}{song.album && ` — ${song.album}`}</span><span>{formatDuration(song.ms)}. {REASONS[song.reason]}.</span>
        </li>)}</ol>
      </>}
      {catalogue && <p className="settings__note">Catalogue: {catalogue.snapshot ?? 'small development snapshot'}. {formatNumber(catalogue.recordings)} recording candidates, {formatNumber(catalogue.albums)} album entries and {formatNumber(catalogue.artistEstimates)} artist entries. These counts describe metadata, not guaranteed coverage.</p>}
    </Modal>
  )
}
