"""Data Danton/Danki: NRP Polri selalu 8 digit, walau Excel membuang angka 0 di depan."""
import os
import tempfile
import unittest
from unittest.mock import patch

_storage = tempfile.TemporaryDirectory(prefix='lhp-komando-tests-')
with patch.dict(os.environ, {'DATA_DIR': _storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server


class KomandoDataTests(unittest.TestCase):
    def test_nrp_is_padded_to_eight_digits(self):
        self.assertEqual(server._norm_nrp('0111147'), '00111147')
        self.assertEqual(server._norm_nrp(1041310), '01041310')
        self.assertEqual(server._norm_nrp('1041310.0'), '01041310')
        self.assertEqual(server._norm_nrp('94081261'), '94081261')
        self.assertEqual(server._norm_nrp(''), '')

    def test_fixed_rows(self):
        self.assertEqual(server.lookup_danton('3', '2', '2'),
                         {'Nama Danton': 'MUHAMMAD ALIF FADILLAH, S.Tr.K., M.A.',
                          'Pangkat Danton': 'IPTU', 'NRP Danton': '00111147'})
        self.assertEqual(server.lookup_danton('3', '2', '3')['NRP Danton'], '01041310')

    def test_every_filled_nrp_has_eight_digits(self):
        for tingkat in ('1', '2', '3'):
            for row in server._load_xlsx_for_tingkat(tingkat):
                nrp = row.get('NRP', '')
                if nrp:
                    self.assertRegex(nrp, r'^\d{8}$', f"{row.get('JABATAN')} ({tingkat})")


if __name__ == '__main__':
    unittest.main()
