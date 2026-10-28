# My Listening Record
[![Live site](https://img.shields.io/badge/live-mylisteningrecord.com-blue)](https://mylisteningrecord.com)

**React + Vite app that visualizes your Spotify or Apple Music listening history.**

Drop in your Spotify **Extended Streaming History** or your Apple Music **privacy export** and get your listening pressed into vinyl, plus a dozen other ways to look at it.

Everything runs in your browser. There's no server, and your data is never uploaded. Even the cover art is generated from names rather than fetched. The built site ships with a Content Security Policy that blocks all network requests (`connect-src 'none'`), so the browser itself enforces that.

## What you get

| | |
|---|---|
| **On a phone** | Held upright, the record is a deck of cards: one track fills the screen, nothing scrolls, and the bar at the bottom (or a quick swipe) deals the next one. It opens straight on The Record. Turn the phone sideways for the whole page. |
| **The Long Play** | A guided walk through the whole record on a bigger screen, one track at a time: each chapter's real chart with a tip for what to play with. The way on waits at the bottom of each track, and at the end the whole page opens up. |
| **The Record** | Every day of listening as a vinyl record: one groove per day, arcs placed by time of day. Tap a groove (or use the slider) and the deck beside it unrolls that day into a 24-hour strip; the tonearm follows. On a phone's card, put a finger on the record and the needle follows it; pinch or double-tap to zoom. |
| **Eras** | Streamgraph of your top artists, with the stretches one artist led your listening called out as eras. |
| **The Race** | Bar chart race of cumulative hours per artist. Turn it into a 9:16 story video, made on your device and ready for Instagram. |
| **Around the Clock** | 24-hour radial chart split into day and night, your artist for each part of the day (on a phone, the one you lean on more than usual), and a weekday × hour dot matrix. |
| **Every Day** | Calendar heatmap, one square per day, a year at a time. On a phone it's a calendar: pick a year, a month and a day, or find a date, and the day opens with everything you played. |
| **Love / Hate** | The song you let play most against the one you skip most, then (on a bigger screen) every most-played song by plays vs. skip rate. |
| **Genres** | Listening time and skip rates by genre, matched against a bundled offline catalogue, with coverage shown. |
| **Constellation** | Force-directed map of artists you play back to back. Clusters are your scenes. |
| **Pulse** | An *Unknown Pleasures*-style ridgeline of your top artists, in the order you found them. |
| **The Charts** | Top artists, songs, albums and podcasts with generative covers. |
| **Liner Notes** | A listener-type card, records (streaks, marathons, obsessions, the artist you went quiet on) and habits. On a phone, the four facts you'd never have guessed. |
| **The Poster** | A shareable PNG in four designs: Deep dive (the record fully annotated, with small charts underneath), The Record, Sleeve (an album cover with a tracklist) and Annotated (a labelled figure). Three sizes (4:5 post, 9:16 story, 2:3 print), on black or cream. Deep dive is 4:5 only, and can come out several times bigger for reading up close. On phones it goes straight to the share sheet. |

Every view follows the year picker at the top.

## Getting your data

**Spotify**

1. Go to [spotify.com/account/privacy](https://www.spotify.com/account/privacy/) and request **Extended streaming history**.
2. Confirm the email, then wait for the download link (up to 30 days).
3. Drop the `.zip` onto the record sleeve.

**Apple Music** (beta: support is new, so please [report anything that looks wrong](https://github.com/CarsonGodwin/on-record/issues))

1. Go to [privacy.apple.com](https://privacy.apple.com/), choose **Request a copy of your data** and check **Apple Media Services information**.
2. Wait for the email (Apple says up to a week).
3. Download every part and drop them all onto the record sleeve. The zips, the folder they unzip to, or the `Apple Music*.csv`/`.json` files all work. Only the Apple Music files are opened; the rest of the export (purchases, Apple Pay and so on) is never read.

You can drop a Spotify export and an Apple Music export together to get one timeline, for example if you switched services.

No data yet? Use **Try the demo**.

## Spotify vs. Apple Music

Both exports become the same plays, so every view works with either. Apple's export records less than Spotify's, so a few things differ:

| | Spotify | Apple Music |
|---|---|---|
| **Artist** | In every row | Not in the play activity. Matched by song title from the export's other Apple Music files (and the library), using the album (from the library and Recently Played) and the day played to tell apart songs that share a title, and spelled the way the export spells that artist most (the library's spelling first). Songs with no match become "Unknown artist (Apple Music)", hidden to start with (Hide Artists… shows them), and Load details counts them. |
| **Shuffle** | Recorded | Recorded only on newer plays. Shuffle stats leave out the plays that don't say, and Load details counts them; with none at all, the shuffle question and shuffle facts are left out. |
| **Podcasts and audiobooks** | Included | Not in Apple Music's export, so the podcast views stay empty. |
| **Skips** | `skipped` flag and end reason | From Apple's end reason (skipped forward). |
| **Plays** | One row per stream | Apple splits a listen whenever you pause or seek; parts of the same song within 30 seconds are joined back into one play. A song on repeat stays separate plays. |
| **Songs** | Told apart by Spotify's track ID | No track IDs, so songs are told apart by artist and title. A single and its album version count as one song. Dropped with a Spotify export, a song with the same artist and title shares Spotify's ID, so it counts as one song across both. |
| **Videos** | Video history files are skipped | Music video plays are left out, and Load details counts them |
| **Devices** | Phone, computer, web, speakers | The same families, plus Apple Watch and Apple TV; HomePod and Alexa count as speakers. Older plays that don't name the app fall back to the device type they record. |

On the Deep dive poster, the credit line names whichever export the data came from.

## Development

```bash
npm install
npm run dev
npm test        # tests in tests/{data,viz,lib} (Vitest)
npm run lint    # oxlint
npm run build   # type-check, then build to dist/
```

## Deploying

The site is hosted on Cloudflare at [mylisteningrecord.com](https://mylisteningrecord.com), which builds and deploys from `production`. Connect the repo under **Workers & Pages** with build command `npm run build` and output directory `dist`. Every push and pull request also runs lint, audit, build and tests in [CI](.github/workflows/ci.yml).

The build emits `dist/_headers`, which Cloudflare applies as response headers: the Content Security Policy plus HSTS, framing and caching rules. The build uses relative asset paths, so `dist/` also works on any other static host, where the CSP meta tag in the page still applies.

### Docker

Build everything with Docker; no local Node.js installation or `dist/` is needed:

```bash
docker build -t on-record .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL --security-opt=no-new-privileges on-record
```

Open `http://localhost:8080`. Build stages install locked dependencies, retrieve public genre metadata from MusicBrainz, and compile the app. Only the compiled site and an unprivileged Alpine NGINX server enter the runtime image. The running container makes no metadata requests and contains no Node.js tooling. The build context excludes listening exports, local `dist/`, dependencies and the committed genre snapshot.

The catalogue stage imports the complete MusicBrainz core and derived bulk snapshots, not a sample of API search results. The first build downloads roughly 7.5 GB compressed and needs substantial additional scratch disk for SQLite tables and indexes. Run it on a build host with enough disk; no large downloads happen during ordinary app tests or local `npm run build`. Only the compact recording-level genre catalogue reaches the app.

Raw archives use a separate BuildKit cache, support interrupted-download resume, and must match the snapshot's SHA256 checksums before import. The catalogue stage is also cached independently from source and npm dependencies. To use a fixed snapshot, pass `--build-arg MUSICBRAINZ_SNAPSHOT=20261028-002228`; otherwise it resolves `latest` on an uncached catalogue build. Use `docker build --no-cache -t on-record .` to resolve it again. An uncached build needs access to the image registry, Alpine packages, npm and MusicBrainz. Failed imports stop the build rather than silently using stale metadata.

Hashed assets use immutable one-year caching; HTML and other files require revalidation. NGINX compresses text responses and serves the build's security headers, including CSP. Image packaging translates the global headers in `dist/_headers` into NGINX configuration, keeping `vite.config.ts` as the single source of header definitions. Put the container behind a TLS reverse proxy for public hosting.

## Project structure

```
src/
  types.ts              Raw Spotify row type and the cleaned-up Play type
  data/parse.ts         Turns one raw Spotify row into a Play
  data/load.ts          Reads zip/JSON/CSV files (including Apple's zips within zips), validates, dedupes
  data/appleFiles.ts    Which files in Apple's privacy export hold Apple Music history
  data/apple.ts         Apple Music's export to Plays: joins split listens, finds artists by title
  data/csv.ts           A small CSV reader that copies out only the columns asked for
  data/sample.ts        Seeded fake history in Spotify's raw format
  data/sampleWords.ts   Invented artist, song, show and book names the sample is built from
  data/stats.ts         Summary numbers, rankings, streaks
  data/insights.ts      Time bins, eras, race frames, sessions, artist graph, listener profile
  data/dayparts.ts      Day and night, and who you lean on in each part of the day
  data/lovehate.ts      The songs you let play and the ones you skip
  data/eraTimeline.ts   Eras placed down a time axis, for the phone's Eras card
  data/pulse.ts         Each Pulse artist's peak month
  data/smallPrint.ts    The liner notes' most surprising facts
  viz/record.ts         The vinyl drawing, shared by the chart and the poster
  viz/constellation.ts  The artist-graph layout, shared by the chart and the poster
  viz/poster.ts         Poster rendering, and the Record, Sleeve and Annotated designs
  viz/posterDeep.ts     The Deep dive poster
  viz/posterShared.ts   Drawing helpers shared by the posters and the race video
  viz/raceVideo.ts      The Race as a 9:16 video, encoded on-device
  lib/palette.ts        Chart colors (validated for colorblind separation on the dark surface)
  lib/dropFiles.ts      Drag-and-drop, including dropped folders
  lib/stage.ts          Which chapter is on stage (The Long Play, or a phone's card)
  lib/swipe.ts          What counts as a swipe between cards
  lib/back.ts           The back gesture closing whatever is open over a card
  components/           One file per visualization, plus Dashboard, PosterStudio, the landing sleeve,
                        The Long Play (Tour) and the phone deck's bottom bar (CardNav)
```

## License

[MIT](LICENSE). The bundled fonts (Bricolage Grotesque, Instrument Serif, JetBrains Mono) are under the [SIL Open Font License 1.1](https://openfontlicense.org).

## Disclaimer

My Listening Record is an independent project, not affiliated with, endorsed by or sponsored by Spotify AB or Apple Inc. Spotify is a trademark of Spotify AB. Apple Music is a trademark of Apple Inc.

## Offline genre catalogue

The dashboard makes no metadata requests. Song tags are imported into the JavaScript bundle at build time; listening histories never enter the catalogue generator. Matching uses artist and title, with album disambiguation when available. Version markers are preserved and conflicting matches remain unknown. There is no artist-level fallback.

To rebuild the catalogue outside Docker, `npm run catalogue:genres` runs the same Python 3 bulk importer. Do this on the build host: it downloads the full archives, not a small development fixture. Options follow `--`, for example `npm run catalogue:genres -- --snapshot 20261028-002228 --cache-dir /data/musicbrainz --work-dir /data/scratch`. Ordinary local app builds use the committed small development snapshot and do not download metadata; production Docker builds import the full catalogue.

The importer reads all official genres and every positive recording-level genre association from one consistent MusicBrainz snapshot, with no genre seed list or per-genre page cap. Untagged recordings sharing an artist/title identity are retained as conflicting candidates so ambiguous matches stay unknown. It does not infer song genres from artist or release tags. The generated metadata reports recording candidates, distinct combined artist-credit names and genres used; those counts describe source metadata, not guaranteed coverage of a listening history.

The browser uses artist/genre dictionaries and a sorted recording lookup, preserving album disambiguation and version markers without constructing a second full Map index. The committed snapshot is a small development fallback; its counts are shown in the app. The demo uses its own seeded fictional song genres.

Artist / Genre beside the year picker changes the grouping across charts, tables, posters and race exports. Real listening records and song drill-downs remain intact. Listening time and counted plays stay unchanged; a multi-genre song contributes an equal fraction to each genre. Starts, skips and transitions labelled “weighted” retain their fractions. Unknown music remains visible as a neutral group and never receives an artist-based genre estimate. Genre Love / Hate compares the least and most skipped known genres; individual-song facts retain real artist names. The choice resets on reload.

Listening time, starts and skips are split equally between a song's accepted genres. Skip rates include short starts and use the same skip definition as the rest of the app. Song and artist counts are distinct within each genre. The breakdown's skip ranking requires 20 weighted starts; historical listening is classified using the snapshot's tags, not historical tags.

Run `npm run test:catalogue` for small synthetic archive and checksum fixtures. These tests make no real metadata downloads; they also run in CI.

**Data licence:** `src/data/catalogue/genres.json` contains genre associations from [MusicBrainz](https://musicbrainz.org), filtered and reformatted by this project. This dataset is separately licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), including its attribution, noncommercial and share-alike conditions; the repository's MIT licence does not relicense it. The generated catalogue records its source snapshot. [MusicBrainz licensing details](https://musicbrainz.org/doc/About/Data_License).
