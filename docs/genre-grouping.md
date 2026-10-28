# Artist and genre grouping

One global Artist / Genre control sits beside the year picker. Existing layouts,
chart styles, gestures, filters and local-only data handling stay in place. The
selection resets on reload and applies to charts, tables, posters and race videos.

Original Play objects remain intact. Aggregations accept a grouping whose members
carry names and weights; artist mode has one member, and genre mode divides a
song's contribution evenly among its tags. Unknown music belongs to “Unknown
genre”. Podcasts and audiobooks keep their existing separate identity. Music-only
and hidden-artist filters run before grouping, and hiding always refers to real
artists. Listening time, starts, counted plays, song identity and chronology are
never changed by the switch.

The Record splits each original day's arc into proportional genre contributions,
retaining the original play index for song drill-downs. Eras, Race and Pulse use
weighted group totals. Constellation weights links between consecutive original
songs; it never invents transitions by expanding one song into several plays.
Clock and Calendar keep their totals but group their leading names and details.
Charts ranks genres in place of artists while keeping song/album/podcast tabs.
Love / Hate uses genre starts/skips in genre mode. Hero, liner notes, tables,
guidance, posters and video text identify their selected grouping honestly;
metrics that concern individual songs keep those real song details.

Switching grouping resets retained chart selection/export state. Genre colours
stay stable across year changes, with unknown coverage shown explicitly. Tests
cover multi-tag conservation, unknowns, original sequence transitions, record
midnight splits, preserved play pointers and unchanged artist-mode results.

Production Docker builds derive a compact, dictionary-based catalogue from the
complete verified MusicBrainz core and derived dumps. There are no genre seeds or
search page caps and no artist/release-level genre fallback. The browser uses a
sorted lookup rather than a second full Map index. Ordinary app development keeps
the committed small snapshot. Bulk pipeline tests use tiny synthetic archives;
real archives and production Docker builds must not be downloaded/run on Ricardo's
workstation. Full-scale resource usage requires validation on the build host.

The production build streams the catalogue into a separate content-hashed local
JavaScript module. It bypasses Vite's parsing/minification pipeline so chunk
rendering does not hold multiple copies of the full dataset. Development and
tests still use the small raw JSON import. Browser memory for the full catalogue
and bulk-import scratch space remain build-host validation requirements.
