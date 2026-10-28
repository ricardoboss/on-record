#!/usr/bin/env python3
"""Build recording genres and labelled album/artist fallbacks from bulk dumps.

Raw archives are cached; the disposable SQLite workspace needs substantial free disk.
Only public names, genre votes and join keys enter SQLite.
"""
import argparse
import hashlib
import inspect
from itertools import groupby
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tarfile
import tempfile
import unicodedata
import urllib.request
from datetime import datetime, timezone

BASE = 'https://data.metabrainz.org/pub/musicbrainz/data/fullexport/'
ARCHIVES = ('mbdump.tar.bz2', 'mbdump-derived.tar.bz2')
MAX_CHUNK_BYTES = 4 * 1024 * 1024
# Column positions follow MusicBrainz admin/sql/CreateTables.sql, not tar order.
TABLES = {
    'genre': ((0, 2), 'id INTEGER PRIMARY KEY,name TEXT'),
    'tag': ((0, 1), 'id INTEGER PRIMARY KEY,name TEXT'),
    'recording_tag': ((0, 1, 2), 'recording INTEGER,tag INTEGER,votes INTEGER'),
    'artist_tag': ((0, 1, 2), 'artist INTEGER,tag INTEGER,votes INTEGER'),
    'release_tag': ((0, 1, 2), 'release INTEGER,tag INTEGER,votes INTEGER'),
    'release_group_tag': ((0, 1, 2), 'release_group INTEGER,tag INTEGER,votes INTEGER'),
    'recording': ((0, 2, 3), 'id INTEGER PRIMARY KEY,title TEXT,credit INTEGER'),
    'artist': ((0, 2), 'id INTEGER PRIMARY KEY,name TEXT'),
    'artist_alias': ((1, 2), 'artist INTEGER,name TEXT'),
    'artist_credit': ((0, 1), 'id INTEGER PRIMARY KEY,name TEXT'),
    'artist_credit_name': ((0, 1, 2, 3), 'credit INTEGER,position INTEGER,artist INTEGER,name TEXT'),
    'track': ((2, 3), 'recording INTEGER,medium INTEGER'),
    'medium': ((0, 1), 'id INTEGER PRIMARY KEY,release INTEGER'),
    'release': ((0, 2, 4), 'id INTEGER PRIMARY KEY,name TEXT,release_group INTEGER'),
}


def normalize(value):
    # ECMAScript whitespace includes BOM but excludes Python's extra controls.
    whitespace = r'[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
    value = unicodedata.normalize('NFC', value)
    value = re.sub(r'[\u2018\u2019\u02bc]', "'", value)
    value = re.sub(r'[\u2010-\u2015\u2212]', '-', value)
    return re.sub(whitespace, ' ', value).strip(' ').lower()


def utf16(value):
    return value.encode('utf-16-be', errors='surrogatepass')


def copy_value(value):
    if value == r'\N':
        return None
    def decode(match):
        escaped = match.group(1)
        if escaped[0] in b'01234567':
            return bytes([int(escaped, 8)])
        if escaped.startswith(b'x') and len(escaped) > 1:
            return bytes([int(escaped[1:], 16)])
        return {b'b': b'\b', b'f': b'\f', b'n': b'\n', b'r': b'\r', b't': b'\t', b'v': b'\v'}.get(escaped, escaped)
    # COPY's octal/hex escapes encode bytes, including multi-byte UTF-8 names.
    return re.sub(rb'\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)', decode, value.encode('utf-8')).decode('utf-8')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, destination, expected_hash=None):
    """Resume an interrupted raw download and publish only after transport completes."""
    partial = destination.with_suffix(destination.suffix + '.part')
    if expected_hash and partial.exists() and digest(partial) == expected_hash:
        os.replace(partial, destination)
        return
    offset = partial.stat().st_size if partial.exists() else 0
    request = urllib.request.Request(url, headers={'Range': f'bytes={offset}-'} if offset else {})
    print(f'Downloading {destination.name} ({offset // (1024 * 1024)} MiB cached partial)', flush=True)
    with urllib.request.urlopen(request, timeout=120) as response:
        resumed = offset and response.status == 206
        if resumed and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
            raise ValueError('Invalid resumed download range')
        received = 0
        progress = 0
        with open(partial, 'ab' if resumed else 'wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                received += len(chunk)
                if received - progress >= 256 * 1024 * 1024:
                    print(f'{destination.name}: {(offset if resumed else 0) // (1024 * 1024) + received // (1024 * 1024)} MiB', flush=True)
                    progress = received
        length = response.headers.get('Content-Length')
        if length is not None and received != int(length):
            raise OSError(f'Incomplete {destination.name}; partial download preserved for resuming')
    if expected_hash and digest(partial) != expected_hash:
        partial.unlink()
        raise ValueError(f'SHA256 mismatch: {destination.name}')
    os.replace(partial, destination)


def acquire(cache, snapshot):
    print(f'Resolving MusicBrainz snapshot: {snapshot}', flush=True)
    if snapshot == 'latest':
        with urllib.request.urlopen(BASE + 'LATEST', timeout=60) as response:
            snapshot = response.read(128).decode('ascii').strip()
    if not re.fullmatch(r'\d{8}-\d{6}', snapshot):
        raise ValueError('Invalid MusicBrainz snapshot')
    directory = cache / snapshot
    directory.mkdir(parents=True, exist_ok=True)
    checksums = directory / 'SHA256SUMS'
    if not checksums.exists():
        download(BASE + snapshot + '/SHA256SUMS', checksums)
    expected = {}
    for line in checksums.read_text().splitlines():
        match = re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?(?:\./)?([^/]+)', line)
        if match:
            expected[match[2]] = match[1].lower()
    paths = []
    for name in ARCHIVES:
        if name not in expected:
            raise ValueError(f'Missing checksum: {name}')
        path = directory / name
        if not path.exists():
            download(BASE + snapshot + '/' + name, path, expected[name])
        elif digest(path) != expected[name]:
            path.unlink()
            raise ValueError(f'SHA256 mismatch: {name}; rerun to download again')
        paths.append(path)
    return snapshot, paths


def import_tables(db, archives):
    for name, (_, schema) in TABLES.items():
        db.execute(f'CREATE TABLE "{name}" ({schema})')
    seen = set()
    for archive in archives:
        with tarfile.open(archive, mode='r|bz2') as tar:
            for member in tar:
                # Read exact known members only; never extract a filesystem path.
                name = member.name.removeprefix('./')
                table = name.removeprefix('mbdump/')
                if name != 'mbdump/' + table or table not in TABLES:
                    continue
                if not member.isfile() or table in seen:
                    raise ValueError(f'Invalid or duplicate table: {table}')
                seen.add(table)
                print(f'Importing {table}', flush=True)
                columns = TABLES[table][0]
                insert = f'INSERT INTO "{table}" VALUES ({",".join("?" for _ in columns)})'
                batch = []
                rows = 0
                with tar.extractfile(member) as stream:
                    for raw in stream:
                        fields = raw.decode('utf-8', errors='strict').rstrip('\n').split('\t')
                        if len(fields) <= max(columns):
                            raise ValueError(f'Malformed COPY row: {table}')
                        values = [copy_value(fields[index]) for index in columns]
                        if any(value is None for value in values):
                            raise ValueError(f'Unexpected NULL: {table}')
                        # Normalize names, never IDs or integer counts.
                        name_columns = {'genre': (1,), 'tag': (1,), 'recording': (1,), 'artist': (1,),
                                        'artist_alias': (1,), 'artist_credit': (1,), 'artist_credit_name': (3,), 'release': (1,)}
                        for index in name_columns.get(table, ()):
                            values[index] = normalize(values[index])
                        text_columns = name_columns.get(table, ())
                        for index, value in enumerate(values):
                            if index not in text_columns:
                                values[index] = int(value)
                        batch.append(values)
                        rows += 1
                        if rows % 1000000 == 0:
                            print(f'{table}: {rows:,} rows', flush=True)
                        if len(batch) == 10000:
                            db.executemany(insert, batch)
                            batch.clear()
                db.executemany(insert, batch)
                db.commit()
                print(f'{table}: {rows:,} rows imported', flush=True)
    if seen != set(TABLES):
        raise ValueError('Missing tables: ' + ', '.join(sorted(set(TABLES) - seen)))


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def write_jsonl_value(stream, value, max_bytes=None):
    max_bytes = MAX_CHUNK_BYTES if max_bytes is None else max_bytes
    line = json_bytes(value) + b'\n'
    if len(line) > max_bytes:
        raise ValueError('Catalogue metadata exceeds the JSONL chunk limit')
    stream.write(line)


def write_jsonl_rows(stream, section, rows, max_bytes=None):
    """Bound each independently parsed module without truncating a row or Unicode text."""
    max_bytes = MAX_CHUNK_BYTES if max_bytes is None else max_bytes
    prefix = b'{"section":' + json_bytes(section) + b',"rows":['
    suffix = b']}\n'
    if len(prefix) + len(suffix) > max_bytes:
        raise ValueError('Catalogue section exceeds the JSONL chunk limit')
    chunks = []
    size = len(prefix) + len(suffix)
    count = 0
    for row in rows:
        encoded = json_bytes(row)
        if len(prefix) + len(encoded) + len(suffix) > max_bytes:
            raise ValueError(f'Catalogue {section} row exceeds the JSONL chunk limit')
        if chunks and size + len(encoded) + 1 > max_bytes:
            stream.write(prefix + b','.join(chunks) + suffix)
            chunks.clear()
            size = len(prefix) + len(suffix)
        size += len(encoded) + bool(chunks)
        chunks.append(encoded)
        count += 1
        if count % 1000000 == 0:
            print(f'{section}: {count:,} compact rows', flush=True)
    # Empty arrays are explicit so consumers need no missing-section defaults.
    if chunks or not count:
        stream.write(prefix + b','.join(chunks) + suffix)
    print(f'{section}: {count:,} compact rows written', flush=True)
    return count


def write_catalogue(db, output, snapshot):
    print('Indexing recording, album and artist genres', flush=True)
    db.executescript("""
        CREATE INDEX genre_name ON genre(name);
        CREATE INDEX recording_identity ON recording(credit,title);
        CREATE INDEX credit_name ON artist_credit(name);
        CREATE INDEX credit_member ON artist_credit_name(artist,credit);
        CREATE TABLE primary_credit AS SELECT credit,artist,name FROM artist_credit_name WHERE position=0;
        CREATE UNIQUE INDEX primary_credit_id ON primary_credit(credit);
        CREATE INDEX primary_artist ON primary_credit(artist,credit);
        CREATE TABLE artist_names AS SELECT id AS artist,name FROM artist
          UNION SELECT artist,name FROM artist_alias UNION SELECT artist,name FROM artist_credit_name;
        CREATE INDEX artist_names_name ON artist_names(name,artist);
        -- A shared alias must not turn one artist's genres into another's.
        CREATE TABLE safe_artist_names AS SELECT MIN(artist) AS artist,name FROM artist_names
          WHERE name<>'' GROUP BY name HAVING COUNT(DISTINCT artist)=1;
        CREATE INDEX safe_artist_names_artist ON safe_artist_names(artist);
        CREATE UNIQUE INDEX safe_artist_names_name ON safe_artist_names(name);
        -- Combined credits can also collide with another artist's name or alias.
        CREATE TABLE safe_album_credit_names AS SELECT MIN(artist) AS artist,name FROM (
          SELECT artist,name FROM artist_names
          UNION ALL SELECT pc.artist,a.name FROM artist_credit a JOIN primary_credit pc ON pc.credit=a.id
        ) WHERE name<>'' GROUP BY name HAVING COUNT(DISTINCT artist)=1;
        CREATE UNIQUE INDEX safe_album_credit_names_name ON safe_album_credit_names(name);
        CREATE INDEX safe_album_credit_names_artist ON safe_album_credit_names(artist);
    """)
    for table, entity in [('recording_tag', 'recording'), ('artist_tag', 'artist'),
                          ('release_tag', 'release'), ('release_group_tag', 'release_group')]:
        db.execute(f"""CREATE TABLE positive_{entity} AS SELECT DISTINCT rt.{entity} AS entity,g.name AS genre
          FROM {table} rt JOIN tag t ON t.id=rt.tag JOIN genre g ON g.name=t.name WHERE rt.votes>0""")
        db.execute(f'CREATE INDEX positive_{entity}_entity ON positive_{entity}(entity)')
    for entity in ('recording', 'artist'):
        db.execute(f"""CREATE TABLE {entity}_genre_sets AS SELECT entity,json_group_array(genre) AS genres
          FROM (SELECT entity,genre FROM positive_{entity} ORDER BY entity,genre) GROUP BY entity""")
        db.execute(f'CREATE UNIQUE INDEX {entity}_genre_sets_entity ON {entity}_genre_sets(entity)')
    db.executescript("""
        CREATE TABLE tagged_identity AS SELECT DISTINCT a.name,r.title FROM positive_recording p
          JOIN recording r ON r.id=p.entity JOIN artist_credit a ON a.id=r.credit;
        CREATE UNIQUE INDEX tagged_identity_name ON tagged_identity(name,title);
        CREATE TABLE tagged_primary AS SELECT DISTINCT pc.artist,r.title FROM positive_recording p
          JOIN recording r ON r.id=p.entity JOIN primary_credit pc ON pc.credit=r.credit;
        CREATE UNIQUE INDEX tagged_primary_identity ON tagged_primary(artist,title);
        -- Keep untagged siblings across both combined credits and primary-artist credits.
        CREATE TABLE selected AS SELECT r.id,r.title,r.credit FROM tagged_identity tagged
          JOIN artist_credit a ON a.name=tagged.name
          JOIN recording r ON r.credit=a.id AND r.title=tagged.title
          UNION SELECT r.id,r.title,r.credit FROM tagged_primary tagged
          JOIN primary_credit pc ON pc.artist=tagged.artist
          JOIN recording r ON r.credit=pc.credit AND r.title=tagged.title;
        CREATE UNIQUE INDEX selected_id ON selected(id);
        CREATE INDEX selected_credit ON selected(credit);
        CREATE TABLE recording_aliases AS SELECT DISTINCT n.name,a.name AS target FROM (SELECT DISTINCT credit FROM selected) s
          JOIN artist_credit a ON a.id=s.credit JOIN primary_credit pc ON pc.credit=s.credit
          JOIN safe_artist_names n ON n.artist=pc.artist WHERE n.name<>a.name;
        CREATE TABLE albums AS SELECT DISTINCT t.recording,r.name FROM track t
          JOIN selected s ON s.id=t.recording JOIN medium m ON m.id=t.medium JOIN release r ON r.id=m.release;
        CREATE INDEX albums_recording ON albums(recording);
        CREATE TABLE recording_album_sets AS SELECT recording,json_group_array(name) AS albums
          FROM (SELECT recording,name FROM albums ORDER BY recording,name) GROUP BY recording;
        CREATE UNIQUE INDEX recording_album_sets_recording ON recording_album_sets(recording);
        CREATE TABLE release_genres AS SELECT entity AS release,genre FROM positive_release
          UNION SELECT r.id,p.genre FROM release r JOIN positive_release_group p ON p.entity=r.release_group
          WHERE NOT EXISTS(SELECT 1 FROM positive_release direct WHERE direct.entity=r.id);
        CREATE INDEX release_genres_release ON release_genres(release);
        CREATE TABLE release_genre_sets AS SELECT release,json_group_array(genre) AS genres
          FROM (SELECT release,genre FROM release_genres ORDER BY release,genre) GROUP BY release;
        CREATE UNIQUE INDEX release_genre_sets_release ON release_genre_sets(release);
        CREATE INDEX medium_release ON medium(release);
        CREATE INDEX track_medium ON track(medium);
        -- Restrict album estimates to the artist of a real track on that release.
        CREATE TABLE album_artists AS SELECT DISTINCT m.release,rec.credit,pc.artist,r.name FROM medium m
          JOIN release r ON r.id=m.release JOIN track t ON t.medium=m.id
          JOIN recording rec ON rec.id=t.recording JOIN primary_credit pc ON pc.credit=rec.credit;
        CREATE INDEX album_artists_release ON album_artists(release);
        CREATE INDEX album_artists_identity ON album_artists(artist,name);
        CREATE TABLE tagged_album_identity AS SELECT DISTINCT aa.artist,aa.name FROM release_genres g
          JOIN album_artists aa ON aa.release=g.release;
        CREATE UNIQUE INDEX tagged_album_identity_key ON tagged_album_identity(artist,name);
        CREATE TABLE selected_albums AS SELECT DISTINCT aa.release AS id,aa.credit FROM tagged_album_identity tagged
          JOIN album_artists aa ON aa.artist=tagged.artist AND aa.name=tagged.name;
        -- Resolve edition disagreement before expanding artist aliases. A NULL set
        -- carries a conflict through the later consensus instead of hiding it.
        CREATE TABLE album_credit_sets AS SELECT s.credit,r.name AS album,
          CASE WHEN COUNT(DISTINCT COALESCE(g.genres,'[]'))=1 THEN MIN(COALESCE(g.genres,'[]')) END AS genres
          FROM selected_albums s JOIN release r ON r.id=s.id
          LEFT JOIN release_genre_sets g ON g.release=r.id GROUP BY s.credit,r.name;
        CREATE TABLE album_entries AS SELECT DISTINCT n.name,s.album,s.genres FROM album_credit_sets s
          JOIN primary_credit pc ON pc.credit=s.credit
          JOIN safe_artist_names n ON n.artist=pc.artist
          JOIN safe_album_credit_names safe ON safe.name=n.name AND safe.artist=pc.artist
          UNION SELECT DISTINCT a.name,s.album,s.genres FROM album_credit_sets s
          JOIN artist_credit a ON a.id=s.credit JOIN primary_credit pc ON pc.credit=s.credit
          JOIN safe_album_credit_names safe ON safe.name=a.name AND safe.artist=pc.artist;
        CREATE TABLE album_consensus AS SELECT name,album,MIN(genres) AS genres FROM album_entries
          GROUP BY name,album HAVING COUNT(*)=COUNT(genres) AND COUNT(DISTINCT genres)=1 AND MIN(genres)<>'[]';
        CREATE TABLE artist_entries AS SELECT DISTINCT n.name,p.entity AS artist FROM positive_artist p
          JOIN safe_album_credit_names n ON n.artist=p.entity;
    """)
    genres = sorted({row[0] for row in db.execute('SELECT name FROM genre')}, key=utf16)
    artists = sorted({row[0] for row in db.execute("""
      SELECT a.name FROM selected s JOIN artist_credit a ON a.id=s.credit
      UNION SELECT name FROM recording_aliases UNION SELECT name FROM album_entries UNION SELECT name FROM artist_entries
    """)}, key=utf16)
    genre_indexes = {name: index for index, name in enumerate(genres)}
    artist_indexes = {name: index for index, name in enumerate(artists)}
    db.create_collation('JS', lambda a, b: (utf16(a) > utf16(b)) - (utf16(a) < utf16(b)))
    metadata = dict(schemaVersion=2, source='MusicBrainz', sourceUrl=BASE + snapshot + '/',
                    license='CC-BY-NC-SA-3.0', licenseUrl='https://creativecommons.org/licenses/by-nc-sa/3.0/',
                    generatedAt=datetime.now(timezone.utc).isoformat(), snapshot=snapshot)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    used = set()
    counts = dict(recordings=0, artists=len(artists), genres=0, albumEntries=0, artistEntries=0)

    def tags(encoded):
        return sorted(genre_indexes[name] for name in json.loads(encoded))

    def recording_rows():
        rows = db.execute("""SELECT a.name,s.title,COALESCE(g.genres,'[]'),albums.albums FROM selected s
          JOIN artist_credit a ON a.id=s.credit LEFT JOIN recording_genre_sets g ON g.entity=s.id
          LEFT JOIN recording_album_sets albums ON albums.recording=s.id
          ORDER BY a.name COLLATE JS,s.title COLLATE JS,COALESCE(g.genres,'[]'),s.id""")
        # Identical genre candidates can share one album union without changing
        # either exact-album matching or the unknown result for disagreeing tags.
        for (artist, title, encoded), candidates in groupby(rows, key=lambda row: row[:3]):
            albums = set()
            for row in candidates:
                if row[3] is not None:
                    albums.update(json.loads(row[3]))
            genres = tags(encoded)
            used.update(genres)
            yield [artist_indexes[artist], title, sorted(albums, key=utf16), genres]

    def album_rows():
        for artist, album, encoded in db.execute('SELECT name,album,genres FROM album_consensus ORDER BY name COLLATE JS,album COLLATE JS'):
            genres = tags(encoded)
            used.update(genres)
            yield [artist_indexes[artist], album, genres]

    def artist_rows():
        for artist, encoded in db.execute("""SELECT a.name,g.genres FROM artist_entries a
          JOIN artist_genre_sets g ON g.entity=a.artist ORDER BY a.name COLLATE JS,a.artist"""):
            genres = tags(encoded)
            used.update(genres)
            yield [artist_indexes[artist], genres]

    try:
        with tempfile.NamedTemporaryFile(mode='wb', dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            write_jsonl_value(stream, {'value': metadata})
            write_jsonl_rows(stream, 'genreNames', genres)
            write_jsonl_rows(stream, 'artistNames', artists)
            counts['recordings'] = write_jsonl_rows(stream, 'recordings', recording_rows())
            aliases = ([artist_indexes[name], artist_indexes[target]] for name, target in
                       db.execute('SELECT name,target FROM recording_aliases ORDER BY name COLLATE JS,target COLLATE JS'))
            write_jsonl_rows(stream, 'recordingAliases', aliases)
            counts['albumEntries'] = write_jsonl_rows(stream, 'albumGenres', album_rows())
            counts['artistEntries'] = write_jsonl_rows(stream, 'artistGenres', artist_rows())
            if not used:
                raise ValueError('Refusing to publish an empty genre catalogue')
            counts['genres'] = len(used)
            write_jsonl_value(stream, {'value': {'counts': counts}})
        os.replace(temporary, output)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(json.dumps(dict(snapshot=snapshot, **counts, bytes=output.stat().st_size)))


def build(archives, output, snapshot, workspace=None, table_cache=None):
    # Cache only the committed source tables. Export/index changes can then reuse
    # a pristine database, and a failed export never poisons the next attempt.
    checkpoint = None
    if table_cache:
        signature = json.dumps(TABLES, sort_keys=True) + ''.join(inspect.getsource(fn) for fn in (normalize, copy_value, import_tables))
        key = hashlib.sha256(signature.encode()).hexdigest()[:16]
        table_cache.mkdir(parents=True, exist_ok=True)
        checkpoint = table_cache / f'{snapshot}-{key}.sqlite'
    with tempfile.TemporaryDirectory(prefix='musicbrainz-', dir=workspace) as temporary:
        database = Path(temporary) / 'catalogue.sqlite'
        cached = checkpoint is not None and checkpoint.is_file()
        if cached:
            print(f'Using imported table cache: {checkpoint.name}', flush=True)
            shutil.copyfile(checkpoint, database)
        with sqlite3.connect(database) as db:
            db.execute('PRAGMA journal_mode=OFF')
            db.execute('PRAGMA synchronous=OFF')
            db.execute('PRAGMA temp_store=FILE')
            db.execute('PRAGMA cache_size=-32768')
            if not cached:
                import_tables(db, archives)
                if checkpoint:
                    db.commit()
                    pending = None
                    try:
                        with tempfile.NamedTemporaryFile(dir=table_cache, delete=False) as stream:
                            pending = Path(stream.name)
                        shutil.copyfile(database, pending)
                        os.replace(pending, checkpoint)
                    finally:
                        if pending and pending.exists():
                            pending.unlink()
                    print('Imported table checkpoint saved', flush=True)
            write_catalogue(db, output, snapshot)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', default=os.environ.get('MUSICBRAINZ_SNAPSHOT', 'latest'))
    parser.add_argument('--cache-dir', type=Path, default=Path('.cache/musicbrainz'))
    parser.add_argument('--work-dir', type=Path, help='Directory for disposable disk-backed SQLite workspace')
    parser.add_argument('--table-cache-dir', type=Path, help='Cache pristine imported tables for repeat exports (uses additional disk)')
    parser.add_argument('--output', type=Path, default=Path('src/data/catalogue/genres.jsonl'))
    args = parser.parse_args()
    snapshot, archives = acquire(args.cache_dir, args.snapshot)
    build(archives, args.output, snapshot, args.work_dir, args.table_cache_dir)


if __name__ == '__main__':
    main()
