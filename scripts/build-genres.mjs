/** Development only: no visitor data is read or sent. */
import { writeFile, rename } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'

const pages = Number(process.argv[2] ?? 5)
if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error('Usage: npm run catalogue:genres -- <pages per genre, 1–100>')
const endpoint = 'https://musicbrainz.org/ws/2/'
let lastRequest = 0
async function request(path, text = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await pause(Math.max(0, 1100 - (Date.now() - lastRequest)))
    lastRequest = Date.now()
    const response = await fetch(endpoint + path, {
      headers: { 'User-Agent': 'OnRecordCatalogue/1.0 (https://github.com/ricardoboss/on-record)', Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    })
    if (response.ok) return text ? response.text() : response.json()
    if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`MusicBrainz: HTTP ${response.status}`)
    await pause(2000 * (attempt + 1))
  }
  throw new Error('MusicBrainz remained unavailable; previous catalogue was preserved.')
}
const allowed = new Set((await request('genre/all?fmt=txt', true)).trim().toLowerCase().split('\n'))
const seeds = ['rock', 'pop', 'hip hop', 'electronic', 'folk', 'jazz', 'classical', 'metal', 'soul', 'country', 'punk', 'reggae']
const recordings = new Map()
for (const seed of seeds) {
  for (let page = 0; page < pages; page++) {
    const query = encodeURIComponent(`tag:"${seed}"`)
    const result = await request(`recording?query=${query}&fmt=json&limit=100&offset=${page * 100}`)
    for (const recording of result.recordings) {
      // A live/remixed recording must not accidentally label the studio version.
      if (recording.disambiguation) continue
      const genres = [...new Set((recording.tags ?? []).filter(t => t.count > 0 && allowed.has(t.name.toLowerCase())).map(t => t.name.toLowerCase()))].sort()
      if (!genres.length) continue
      const artist = recording['artist-credit'].map(c => c.name + (c.joinphrase ?? '')).join('')
      const albums = [...new Set((recording.releases ?? []).map(r => r.title))]
      recordings.set(recording.id, { id: recording.id, artist, title: recording.title, albums, genres })
    }
    console.log(`${seed}: page ${page + 1}, ${recordings.size} tagged recordings`)
    if ((page + 1) * 100 >= result.count) break
  }
}
const data = {
  source: 'MusicBrainz', sourceUrl: 'https://musicbrainz.org',
  license: 'CC-BY-NC-SA-3.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
  generatedAt: new Date().toISOString(), pagesPerGenre: pages,
  recordings: [...recordings.values()].sort((a, b) => a.id.localeCompare(b.id)),
}
const output = new URL('../src/data/catalogue/genres.json', import.meta.url)
const temporary = new URL('../src/data/catalogue/genres.json.tmp', import.meta.url)
await writeFile(temporary, JSON.stringify(data) + '\n')
await rename(temporary, output)
console.log(`Wrote ${data.recordings.length} recordings. Genre associations retain their separate CC-BY-NC-SA licence.`)
