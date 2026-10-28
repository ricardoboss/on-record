#!/usr/bin/env python3
"""Build the recording-only genre catalogue from verified MusicBrainz bulk dumps.

Raw archives are cached; the disposable SQLite workspace needs substantial free disk.
No artist or release tags are used. Only public names and join keys enter SQLite.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tarfile
import tempfile
import unicodedata
import urllib.request
from datetime import datetime, timezone

BASE = 'https://data.metabrainz.org/pub/musicbrainz/data/fullexport/'
ARCHIVES = ('mbdump.tar.bz2', 'mbdump-derived.tar.bz2')
# Column positions follow MusicBrainz admin/sql/CreateTables.sql, not tar order.
TABLES = {
    'genre': ((0, 2), 'id INTEGER PRIMARY KEY,name TEXT'),
    'tag': ((0, 1), 'id INTEGER PRIMARY KEY,name TEXT'),
    'recording_tag': ((0, 1, 2), 'recording INTEGER,tag INTEGER,votes INTEGER'),
    'recording': ((0, 2, 3), 'id INTEGER PRIMARY KEY,title TEXT,credit INTEGER'),
    'artist_credit': ((0, 1), 'id INTEGER PRIMARY KEY,name TEXT'),
    'track': ((2, 3), 'recording INTEGER,medium INTEGER'),
    'medium': ((0, 1), 'id INTEGER PRIMARY KEY,release INTEGER'),
    'release': ((0, 2), 'id INTEGER PRIMARY KEY,name TEXT'),
}


def normalize(value):
    # ECMAScript whitespace includes BOM but excludes Python's extra controls.
    whitespace = r'[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
    return re.sub(whitespace, ' ', unicodedata.normalize('NFC', value)).strip(' ').lower()


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
                        name_columns = {'genre': (1,), 'tag': (1,), 'recording': (1,), 'artist_credit': (1,), 'release': (1,)}
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


def write_catalogue(db, output, snapshot):
    db.executescript('''
        CREATE INDEX rt_tag ON recording_tag(tag);
        CREATE INDEX tag_name ON tag(name);
        CREATE TABLE positive AS SELECT DISTINCT rt.recording,g.name AS genre
          FROM recording_tag rt JOIN tag t ON t.id=rt.tag JOIN genre g ON g.name=t.name WHERE rt.votes>0;
        CREATE INDEX positive_recording ON positive(recording);
        CREATE INDEX recording_identity ON recording(credit,title);
        CREATE INDEX credit_name ON artist_credit(name);
        CREATE TABLE tagged_identity AS SELECT DISTINCT a.name,r.title FROM positive p
          JOIN recording r ON r.id=p.recording JOIN artist_credit a ON a.id=r.credit;
        CREATE UNIQUE INDEX tagged_identity_name ON tagged_identity(name,title);
        CREATE TABLE selected AS SELECT r.id,r.title,r.credit FROM tagged_identity tagged
          JOIN artist_credit a ON a.name=tagged.name
          JOIN recording r ON r.credit=a.id AND r.title=tagged.title;
        CREATE UNIQUE INDEX selected_id ON selected(id);
        CREATE TABLE albums AS SELECT DISTINCT t.recording,r.name FROM track t
          JOIN selected s ON s.id=t.recording JOIN medium m ON m.id=t.medium JOIN release r ON r.id=m.release;
        CREATE INDEX albums_recording ON albums(recording);
    ''')
    genres = sorted({row[0] for row in db.execute('SELECT name FROM genre')}, key=utf16)
    artists = sorted({row[0] for row in db.execute('SELECT a.name FROM selected s JOIN artist_credit a ON a.id=s.credit')}, key=utf16)
    genre_indexes = {name: index for index, name in enumerate(genres)}
    artist_indexes = {name: index for index, name in enumerate(artists)}
    db.create_collation('JS', lambda a, b: (utf16(a) > utf16(b)) - (utf16(a) < utf16(b)))
    metadata = dict(schemaVersion=2, source='MusicBrainz', sourceUrl=BASE + snapshot + '/',
                    license='CC-BY-NC-SA-3.0', licenseUrl='https://creativecommons.org/licenses/by-nc-sa/3.0/',
                    generatedAt=datetime.now(timezone.utc).isoformat(), snapshot=snapshot,
                    genreNames=genres, artistNames=artists)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    count = 0
    used = set()
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))[:-1] + ',"recordings":[')
            for rid, title, artist in db.execute('SELECT s.id,s.title,a.name FROM selected s JOIN artist_credit a ON a.id=s.credit ORDER BY a.name COLLATE JS,s.title COLLATE JS,s.id'):
                albums = sorted({row[0] for row in db.execute('SELECT name FROM albums WHERE recording=?', (rid,))}, key=utf16)
                tags = sorted({genre_indexes[row[0]] for row in db.execute('SELECT genre FROM positive WHERE recording=?', (rid,))})
                used.update(tags)
                row = [artist_indexes[artist], title, albums, tags]
                stream.write((',' if count else '') + json.dumps(row, ensure_ascii=False, separators=(',', ':')))
                count += 1
            if not count or not used:
                raise ValueError('Refusing to publish an empty genre catalogue')
            counts = dict(recordings=count, artists=len(artists), genres=len(used))
            stream.write('],"counts":' + json.dumps(counts, separators=(',', ':')) + '}\n')
        os.replace(temporary, output)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(json.dumps(dict(snapshot=snapshot, **counts, bytes=output.stat().st_size)))


def build(archives, output, snapshot, workspace=None):
    with tempfile.TemporaryDirectory(prefix='musicbrainz-', dir=workspace) as temporary:
        with sqlite3.connect(Path(temporary) / 'catalogue.sqlite') as db:
            db.execute('PRAGMA journal_mode=OFF')
            db.execute('PRAGMA synchronous=OFF')
            db.execute('PRAGMA temp_store=FILE')
            db.execute('PRAGMA cache_size=-32768')
            import_tables(db, archives)
            write_catalogue(db, output, snapshot)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', default=os.environ.get('MUSICBRAINZ_SNAPSHOT', 'latest'))
    parser.add_argument('--cache-dir', type=Path, default=Path('.cache/musicbrainz'))
    parser.add_argument('--work-dir', type=Path, help='Directory for disposable disk-backed SQLite workspace')
    parser.add_argument('--output', type=Path, default=Path('src/data/catalogue/genres.json'))
    args = parser.parse_args()
    snapshot, archives = acquire(args.cache_dir, args.snapshot)
    build(archives, args.output, snapshot, args.work_dir)


if __name__ == '__main__':
    main()
