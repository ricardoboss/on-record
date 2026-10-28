"""Checkpoint reuse uses the same tiny archives as the importer regressions."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_bulk import archive, bulk, fixtures


class TableCacheTests(unittest.TestCase):
    def test_failed_export_keeps_pristine_import_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump, output, cache = root / 'dump.bz2', root / 'genres.jsonl', root / 'tables'
            archive(dump, fixtures())
            output.write_text('previous')
            calls = []
            original = bulk.import_tables

            def counted_import(db, archives):
                calls.append(True)
                original(db, archives)

            with patch.object(bulk, 'import_tables', counted_import):
                with patch.object(bulk, 'write_catalogue', side_effect=RuntimeError('export failed')):
                    with self.assertRaisesRegex(RuntimeError, 'export failed'):
                        bulk.build([dump], output, 'fixture', table_cache=cache)
                self.assertEqual(output.read_text(), 'previous')
                bulk.build([dump], output, 'fixture', table_cache=cache)
                # Export creates indexes/tables; a second export must get a clean copy.
                bulk.build([dump], output, 'fixture', table_cache=cache)
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(list(cache.glob('*.sqlite'))), 1)
            self.assertNotEqual(output.read_text(), 'previous')

    def test_incomplete_import_is_never_published_as_a_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump, output, cache = root / 'dump.bz2', root / 'genres.jsonl', root / 'tables'
            tables = fixtures()
            del tables['tag']
            archive(dump, tables)
            with self.assertRaisesRegex(ValueError, 'Missing tables'):
                bulk.build([dump], output, 'fixture', table_cache=cache)
            self.assertEqual(list(cache.iterdir()), [])
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
