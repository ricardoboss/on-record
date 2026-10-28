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
search page caps. The browser uses a
sorted lookup rather than a second full Map index. Ordinary app development keeps
the committed small snapshot. Bulk pipeline tests use tiny synthetic archives;
real archives and production Docker builds require substantial disk space. Ricardo
subsequently authorized a full Docker build for end-to-end fallback validation.

The production build compresses bounded JSONL chunks into content-hashed local
JavaScript modules outside Vite's parsing/minification pipeline. Artist mode loads
none of the full payloads. Genre preparation uses short-lived workers to load
public modules in fixed order; workers receive no listening-history identifiers.
The page decodes chunks individually and retains only relevant candidates,
including ambiguous and untagged siblings needed for conservative matching.
Public payloads and workers are released on completion or cancellation. Each
source chunk is capped at 4 MiB UTF-8. Development/tests use the small JSON snapshot.
The first full preparation can take over a minute; filters reuse its lookup.

Equivalent recording candidates share their album union. Album-edition consensus
is resolved before alias expansion/export; conflicting or empty album estimates
are omitted, preserving the browser's artist fallback. Docker caches pristine
source-table databases by snapshot/import rules and exports from disposable
copies, so an interrupted export can reuse the expensive import.

Genre coverage uses direct recording tags first, then artist-and-album tags
(release tags before release-group tags), then artist tags as estimates. Estimates
are enabled by default and can be disabled in Settings for every view/export;
the setting resets on reload. The coverage dialog separates all three sources and
unknowns, reports unresolved recording-match reasons and lists the top twenty
unknown songs. No listening data enters the build or a metadata request.

The bulk schema remains version 2, with optional sorted recordingAliases,
albumGenres and artistGenres arrays. Artist names include unambiguous aliases and
primary credited names, and tagged album/artist entries exist independently of
recording tags. Conflicting candidate genre sets remain unresolved rather than
being unioned. Names normalize typographic quotes/dashes but retain live, remix
and version markers. The original small development snapshot stays supported.
