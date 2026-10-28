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
        'recording_tag': '1\t1\t2\tdate\n1\t2\t1\tdate\n2\t1\t0\tdate\n3\t3\t3\tdate\n4\t1\t-1\tdate\n5\t2\t1\tdate\n',
        'recording': '1\tgid\t Song (Live) \t1\n2\tgid\tSong (Live)\t3\n3\tgid\tMood\t2\n4\tgid\tNegative\t2\n5\tgid\tOther\t2\n',
        'artist_credit': '1\tArtist & Guest\n2\tOther Artist\n3\tArtist & Guest\n',
        'track': '1\tgid\t1\t1\n2\tgid\t2\t2\n',
        'medium': '1\t1\n2\t2\n',
        'release': '1\tgid\tAlbum\n2\tgid\tAlternate\n',
    }


def archive(path, tables):
    with tarfile.open(path, 'w:bz2') as tar:
        for name, rows in reversed(list(tables.items())):
            payload = rows.encode()
            member = tarfile.TarInfo('mbdump/' + name)
            member.size = len(payload)
            tar.addfile(member, io.BytesIO(payload))


class BulkTests(unittest.TestCase):
    def test_recording_tags_combined_credit_albums_and_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            tables = fixtures()
            archive(directory / 'core.bz2', {k: v for k, v in tables.items() if k not in ('tag', 'recording_tag')})
            archive(directory / 'derived.bz2', {k: tables[k] for k in ('tag', 'recording_tag')})
            output = directory / 'out.json'
            bulk.build([directory / 'derived.bz2', directory / 'core.bz2'], output, 'fixture')
            result = json.loads(output.read_text())
            self.assertEqual(result['genreNames'], ['jazz', 'rock', 'unused'])
            self.assertEqual(result['artistNames'], ['artist & guest', 'other artist'])
            self.assertEqual(result['recordings'], [[0, 'song (live)', ['album'], [0, 1]], [0, 'song (live)', ['alternate'], []], [1, 'other', [], [0]]])
            self.assertEqual(result['counts'], {'recordings': 3, 'artists': 2, 'genres': 2})

    def test_copy_escaping_and_unicode(self):
        self.assertIsNone(bulk.copy_value(r'\N'))
        self.assertEqual(bulk.copy_value(r'one\ttwo\nthree\\four'), 'one\ttwo\nthree\\four')
        self.assertEqual(bulk.normalize('  BEYONCE\u0301\t &  Guest '), 'beyoncé & guest')
        self.assertEqual(bulk.copy_value(r'\101\x42'), 'AB')
        self.assertEqual(bulk.copy_value(r'Beyonc\303\251'), 'Beyoncé')
        self.assertEqual(bulk.copy_value(r'\xC3\xA9'), 'é')
        self.assertEqual(bulk.normalize('\ufeff A\ufeffB '), 'a b')
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
                    tables['recording_tag'] = ''
                archive(directory / 'dump.bz2', tables)
                output = directory / 'out.json'
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
