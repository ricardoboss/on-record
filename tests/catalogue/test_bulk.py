"""Tiny local tar fixtures only: these tests never contact MusicBrainz."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bulk', Path(__file__).parents[2] / 'scripts/build-genres-bulk.py')
bulk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bulk)


def fixtures():
    # Trailing COPY columns not selected by the importer are immaterial.
    return {
        'genre': '1\tgid\tRock\n2\tgid\tJazz\n3\tgid\tUnused\n',
        'tag': '1\trock\t1\n2\tjazz\t1\n3\thappy\t1\n',
        'artist_tag': '2\t2\t10\tdate\n',
        'release_tag': '1\t2\t10\tdate\n',
        'release_group_tag': '10\t1\t10\tdate\n20\t1\t10\tdate\n',
        'recording_tag': '1\t1\t2\tdate\n1\t2\t1\tdate\n2\t1\t0\tdate\n3\t3\t3\tdate\n4\t1\t-1\tdate\n5\t2\t1\tdate\n',
        'recording': '1\tgid\t Song (Live) \t1\n2\tgid\tSong (Live)\t3\n3\tgid\tMood\t2\n4\tgid\tNegative\t2\n5\tgid\tOther\t2\n',
        'artist_credit': '1\tArtist & Guest\n2\tOther Artist\n3\tArtist & Guest\n',
        'artist': '1\tgid\tArtist\n2\tgid\tOther Artist\n3\tgid\tGuest\n',
        'artist_alias': '1\t1\tArtist Alias\n2\t2\tOther Alias\n3\t2\tShared\n4\t3\tShared\n',
        'artist_credit_name': '1\t0\t1\tArtist\n1\t1\t3\tGuest\n2\t0\t2\tOther Artist\n3\t0\t1\tArtist\n',
        'track': '1\tgid\t1\t1\n2\tgid\t2\t2\n',
        'medium': '1\t1\n2\t2\n',
        'release': '1\tgid\tAlbum\t1\t10\n2\tgid\tAlternate\t3\t20\n',
    }


def archive(path, tables):
    with tarfile.open(path, 'w:bz2') as tar:
        for name, rows in reversed(list(tables.items())):
            payload = rows.encode()
            member = tarfile.TarInfo('mbdump/' + name)
            member.size = len(payload)
            tar.addfile(member, io.BytesIO(payload))


def read_catalogue(path):
    result = {}
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            chunk = json.loads(line)
            if 'value' in chunk:
                result.update(chunk['value'])
            else:
                result.setdefault(chunk['section'], []).extend(chunk['rows'])
    return result


class BulkTests(unittest.TestCase):
    def test_equivalent_recordings_share_album_union_without_changing_matching(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['recording'] += '6\tgid\tSong (Live)\t1\n7\tgid\tSong (Live)\t1\n'
            tables['recording_tag'] += '6\t2\t2\tdate\n6\t1\t1\tdate\n7\t1\t1\tdate\n'
            tables['track'] += '3\tgid\t6\t3\n'
            tables['medium'] += '3\t3\n'
            tables['release'] += '3\tgid\tReissue\t1\t10\n'
            archive(directory / 'dump.bz2', tables)
            bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
            result = read_catalogue(directory / 'out.jsonl')
            artist = result['artistNames'].index('artist & guest')
            compact = [row for row in result['recordings'] if row[:2] == [artist, 'song (live)']]
            self.assertEqual(len(compact), 3)
            self.assertIn([artist, 'song (live)', ['album', 'reissue'], [0, 1]], compact)
            self.assertIn([artist, 'song (live)', ['alternate'], []], compact)
            self.assertIn([artist, 'song (live)', [], [1]], compact)

            original = [[artist, 'song (live)', ['album'], [0, 1]],
                        [artist, 'song (live)', ['reissue'], [0, 1]],
                        [artist, 'song (live)', ['alternate'], []],
                        [artist, 'song (live)', [], [1]]]

            def accepted(rows, album):
                exact = [row for row in rows if album and album in row[2]]
                choices = {tuple(row[3]) for row in (exact or rows)}
                return next(iter(choices)) if len(choices) == 1 else ()

            for album, expected in [('album', (0, 1)), ('reissue', (0, 1)), ('alternate', ()), ('', ()), ('missing', ())]:
                self.assertEqual(accepted(original, album), expected)
                self.assertEqual(accepted(compact, album), expected)

    def test_album_editions_collapse_only_when_every_genre_set_agrees(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['release'] += '3\tgid\tAlbum\t1\t30\n4\tgid\tConflicting\t1\t40\n5\tgid\tConflicting\t1\t50\n'
            tables['medium'] += '3\t3\n4\t4\n5\t5\n'
            tables['track'] += '3\tgid\t1\t3\n4\tgid\t1\t4\n5\tgid\t2\t5\n'
            tables['release_tag'] += '3\t2\t1\tdate\n4\t1\t1\tdate\n5\t2\t1\tdate\n'
            archive(directory / 'dump.bz2', tables)
            bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
            result = read_catalogue(directory / 'out.jsonl')
            artist = result['artistNames'].index('artist')
            self.assertEqual([row for row in result['albumGenres'] if row[:2] == [artist, 'album']], [[artist, 'album', [0]]])
            self.assertFalse(any(row[1] == 'conflicting' for row in result['albumGenres']))

    def test_jsonl_chunks_bound_utf8_bytes_and_keep_empty_arrays(self):
        rows = ['🎵 Beyoncé "\\\n' + str(index) for index in range(8)]
        stream = io.BytesIO()
        self.assertEqual(bulk.write_jsonl_rows(stream, 'artistNames', rows, max_bytes=100), len(rows))
        lines = stream.getvalue().splitlines(keepends=True)
        self.assertGreater(len(lines), 1)
        self.assertTrue(all(len(line) <= 100 for line in lines))
        self.assertEqual([row for line in lines for row in json.loads(line)['rows']], rows)
        empty = io.BytesIO()
        self.assertEqual(bulk.write_jsonl_rows(empty, 'recordings', []), 0)
        self.assertEqual(json.loads(empty.getvalue()), {'section': 'recordings', 'rows': []})
        with self.assertRaisesRegex(ValueError, 'section exceeds'):
            bulk.write_jsonl_rows(io.BytesIO(), 'recordings', [], max_bytes=1)
        with self.assertRaisesRegex(ValueError, 'row exceeds'):
            bulk.write_jsonl_rows(io.BytesIO(), 'artistNames', ['🎵' * 100], max_bytes=100)
        with self.assertRaisesRegex(ValueError, 'metadata exceeds'):
            bulk.write_jsonl_value(io.BytesIO(), {'value': '🎵' * 100}, max_bytes=100)

    def test_oversized_row_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['recording'] += '6\tgid\t' + '🎵' * 300 + '\t1\n'
            tables['recording_tag'] += '6\t1\t1\tdate\n'
            archive(directory / 'dump.bz2', tables)
            output = directory / 'out.jsonl'
            output.write_text('previous')
            with patch.object(bulk, 'MAX_CHUNK_BYTES', 512):
                with self.assertRaisesRegex(ValueError, 'row exceeds'):
                    bulk.build([directory / 'dump.bz2'], output, 'fixture')
            self.assertEqual(output.read_text(), 'previous')

    def test_recording_tags_combined_credit_albums_and_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            archive(directory / 'core.bz2', {k: v for k, v in tables.items() if k not in ('tag', 'recording_tag')})
            archive(directory / 'derived.bz2', {k: tables[k] for k in ('tag', 'recording_tag')})
            output = directory / 'out.jsonl'
            bulk.build([directory / 'derived.bz2', directory / 'core.bz2'], output, 'fixture')
            result = read_catalogue(output)
            self.assertEqual(result['genreNames'], ['jazz', 'rock', 'unused'])
            self.assertEqual(result['artistNames'], ['artist', 'artist & guest', 'artist alias', 'other alias', 'other artist'])
            self.assertEqual(result['recordings'], [[1, 'song (live)', ['album'], [0, 1]], [1, 'song (live)', ['alternate'], []], [4, 'other', [], [0]]])
            self.assertEqual(result['recordingAliases'], [[0, 1], [2, 1], [3, 4]])
            # The release's jazz overrides the release group's rock; Alternate uses its group.
            self.assertEqual(result['albumGenres'], [[0, 'album', [0]], [0, 'alternate', [1]], [1, 'album', [0]], [1, 'alternate', [1]], [2, 'album', [0]], [2, 'alternate', [1]]])
            self.assertEqual(result['artistGenres'], [[3, [0]], [4, [0]]])
            self.assertEqual(result['counts'], {'recordings': 3, 'artists': 5, 'genres': 2, 'albumEntries': 6, 'artistEntries': 2})

    def test_fallbacks_exist_without_any_tagged_recordings(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['recording_tag'] = ''
            archive(directory / 'dump.bz2', tables)
            bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
            result = read_catalogue(directory / 'out.jsonl')
            self.assertEqual(result['recordings'], [])
            self.assertTrue(result['artistGenres'])
            self.assertTrue(result['albumGenres'])
            self.assertNotIn('shared', result['artistNames'])

    def test_primary_artist_aliases_include_untagged_siblings_with_different_combined_credits(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['artist_credit'] += '4\tArtist Solo\n'
            tables['artist_credit_name'] += '4\t0\t1\tArtist\n'
            tables['recording'] += '6\tgid\tSong (Live)\t4\n'
            archive(directory / 'dump.bz2', tables)
            bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
            result = read_catalogue(directory / 'out.jsonl')
            artist = result['artistNames'].index('artist')
            solo = result['artistNames'].index('artist solo')
            self.assertIn([artist, solo], result['recordingAliases'])
            self.assertIn([solo, 'song (live)', [], []], result['recordings'])

    def test_album_conflicts_are_omitted_and_artist_homonyms_stay_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['release'] += '3\tgid\tAlbum\t1\t30\n'
            tables['medium'] += '3\t3\n'
            tables['track'] += '3\tgid\t1\t3\n'
            tables['artist'] += '4\tgid\tSame Name\n5\tgid\tSame Name\n'
            tables['artist_tag'] += '4\t1\t10\tdate\n'
            archive(directory / 'dump.bz2', tables)
            bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
            result = read_catalogue(directory / 'out.jsonl')
            artist = result['artistNames'].index('artist')
            self.assertEqual([row[2] for row in result['albumGenres'] if row[:2] == [artist, 'album']], [])
            self.assertNotIn('same name', result['artistNames'])

    def test_album_combined_credit_names_cannot_bypass_homonym_safety(self):
        for collision in ('credit', 'canonical', 'alias'):
            with self.subTest(collision=collision), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                tables = fixtures()
                tables['artist'] += '4\tgid\tTwin\n5\tgid\t' + ('Twin' if collision == 'canonical' else 'Other Twin') + '\n'
                tables['artist_credit'] += '4\tTwin\n5\t' + ('Twin' if collision == 'credit' else 'Other Twin') + '\n'
                tables['artist_credit_name'] += '4\t0\t4\tTwin\n5\t0\t5\tOther Twin\n'
                if collision == 'alias':
                    tables['artist_alias'] += '5\t5\tTwin\n'
                tables['recording'] += '6\tgid\tFirst Song\t4\n7\tgid\tSecond Song\t5\n'
                tables['release'] += '3\tgid\tDebut\t4\t30\n4\tgid\tDebut\t5\t40\n'
                tables['medium'] += '3\t3\n4\t4\n'
                tables['track'] += '3\tgid\t6\t3\n4\tgid\t7\t4\n'
                tables['release_tag'] += '3\t2\t10\tdate\n'
                archive(directory / 'dump.bz2', tables)
                bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
                result = read_catalogue(directory / 'out.jsonl')
                twin = result['artistNames'].index('twin') if 'twin' in result['artistNames'] else None
                self.assertFalse(any(row[0] == twin and row[1] == 'debut' for row in result['albumGenres']))

    def test_artist_estimates_include_unique_combined_credits_and_reject_other_credit_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            tables['artist_tag'] += '1\t1\t10\tdate\n'
            # A credit can collide with another artist's canonical name even when
            # their ordinary artist names and aliases are individually unique.
            tables['artist'] += '4\tgid\tCredit Collision\n5\tgid\tUnrelated Artist\n'
            tables['artist_credit'] += '4\tCredit Collision\n'
            tables['artist_credit_name'] += '4\t0\t5\tUnrelated Artist\n'
            tables['artist_tag'] += '4\t2\t10\tdate\n'
            archive(directory / 'dump.bz2', tables)
            bulk.build([directory / 'dump.bz2'], directory / 'out.jsonl', 'fixture')
            result = read_catalogue(directory / 'out.jsonl')
            combined = result['artistNames'].index('artist & guest')
            self.assertIn([combined, [result['genreNames'].index('rock')]], result['artistGenres'])
            self.assertNotIn('credit collision', result['artistNames'])

    def test_copy_escaping_and_unicode(self):
        self.assertIsNone(bulk.copy_value(r'\N'))
        self.assertEqual(bulk.copy_value(r'one\ttwo\nthree\\four'), 'one\ttwo\nthree\\four')
        self.assertEqual(bulk.normalize('  BEYONCE\u0301\t &  Guest '), 'beyoncé & guest')
        self.assertEqual(bulk.copy_value(r'\101\x42'), 'AB')
        self.assertEqual(bulk.copy_value(r'Beyonc\303\251'), 'Beyoncé')
        self.assertEqual(bulk.copy_value(r'\xC3\xA9'), 'é')
        self.assertEqual(bulk.normalize('\ufeff A\ufeffB '), 'a b')
        self.assertEqual(bulk.normalize('Artist’s Song — Live'), "artist's song - live")
        self.assertEqual(sorted(['\ue000', '😀'], key=bulk.utf16), ['😀', '\ue000'])

    def test_missing_and_malformed_tables_preserve_output(self):
        for changed in ('missing', 'malformed', 'empty'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                tables = fixtures()
                if changed == 'missing':
                    del tables['tag']
                elif changed == 'malformed':
                    tables['recording'] = '1\ttoo short\n'
                else:
                    for name in ('recording_tag', 'artist_tag', 'release_tag', 'release_group_tag'):
                        tables[name] = ''
                archive(directory / 'dump.bz2', tables)
                output = directory / 'out.jsonl'
                output.write_text('previous')
                with self.assertRaises(ValueError):
                    bulk.build([directory / 'dump.bz2'], output, 'fixture')
                self.assertEqual(output.read_text(), 'previous')

    def test_checksum_failure_precedes_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = '20261028-002228'
            cache = root / snapshot
            cache.mkdir()
            (cache / 'SHA256SUMS').write_text('\n'.join('0' * 64 + '  ' + name for name in bulk.ARCHIVES))
            (cache / bulk.ARCHIVES[0]).write_bytes(b'bad')
            with patch.object(bulk.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')):
                with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                    bulk.acquire(root, snapshot)
            self.assertFalse((cache / bulk.ARCHIVES[0]).exists())

    def test_truncated_download_stays_partial_and_resumes_before_publication(self):
        def response(payload, status, headers):
            result = io.BytesIO(payload)
            result.status, result.headers = status, headers
            return result
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'archive.bz2'
            checksum = hashlib.sha256(b'abcdef').hexdigest()
            with patch.object(bulk.urllib.request, 'urlopen', return_value=response(b'abc', 200, {'Content-Length': '6'})):
                with self.assertRaisesRegex(OSError, 'Incomplete'):
                    bulk.download('https://example.invalid/archive', destination, checksum)
            self.assertFalse(destination.exists())
            self.assertEqual(destination.with_suffix('.bz2.part').read_bytes(), b'abc')
            with patch.object(bulk.urllib.request, 'urlopen', return_value=response(b'def', 206, {'Content-Length': '3', 'Content-Range': 'bytes 3-5/6'})):
                bulk.download('https://example.invalid/archive', destination, checksum)
            self.assertEqual(destination.read_bytes(), b'abcdef')
            self.assertFalse(destination.with_suffix('.bz2.part').exists())

    def test_complete_verified_partial_is_published_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'archive.bz2'
            destination.with_suffix('.bz2.part').write_bytes(b'complete')
            with patch.object(bulk.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')):
                bulk.download('https://example.invalid/archive', destination, hashlib.sha256(b'complete').hexdigest())
            self.assertEqual(destination.read_bytes(), b'complete')

    def test_verified_cached_archives_need_no_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = '20261028-002228'
            cache = root / snapshot
            cache.mkdir()
            sums = []
            for name in bulk.ARCHIVES:
                (cache / name).write_bytes(b'fixture')
                sums.append(hashlib.sha256(b'fixture').hexdigest() + '  ' + name)
            (cache / 'SHA256SUMS').write_text('\n'.join(sums))
            with patch.object(bulk.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')):
                resolved, paths = bulk.acquire(root, snapshot)
            self.assertEqual(resolved, snapshot)
            self.assertEqual(len(paths), 2)


if __name__ == '__main__':
    unittest.main()
