"""Token rules: documents are free; 1 token opens the AI pass for one document."""
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from PIL import Image

_storage = tempfile.TemporaryDirectory(prefix='lhp-ai-token-tests-')
with patch.dict(os.environ, {'DATA_DIR': _storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server

FORM = {'Nama': 'BUDI', 'No Ak': '123', 'Pangkat': 'BHAYANGKARA TARUNA', 'Tingkat': '2',
        'Peleton': '1', 'Kompi': '2', 'Nama Danton': 'A', 'Pangkat Danton': 'IPDA',
        'NRP Danton': '1', 'Nama Danki': 'B', 'Pangkat Danki': 'AKP', 'NRP Danki': '2',
        'Nama Kegiatan': 'OLAHRAGA', 'Tanggal Kegiatan': 'MINGGU, 17 MEI 2026',
        'Waktu Kegiatan': '08.00 WIB', 'Tempat Kegiatan': 'LAPANGAN'}


def jpeg():
    out = io.BytesIO()
    Image.new('RGB', (80, 60), 'white').save(out, 'JPEG')
    return out.getvalue()


class AiTokenTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in (('USERS_FILE', os.path.join(tmp.name, 'users.json')),
                            ('SCAN_USAGE_FILE', os.path.join(tmp.name, 'scan.json')),
                            ('_users_cache', {'mtime': None, 'data': None}),
                            ('ANTHROPIC_API_KEY', 'test-key-never-sent'),
                            ('SCAN_DAILY_LIMIT', 1000)):
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        server._save_users({'tester': {'uid': 'tester', 'username': 'tester', 'name': 'T',
                                       'tokens': 1, 'last_regen': '2999-01-01T00:00:00+00:00'}})
        self.client = server.app.test_client()
        with self.client.session_transaction() as session:
            session['uid'] = 'tester'
        self.urlopen = patch('urllib.request.urlopen')
        self.remote = self.urlopen.start()
        self.addCleanup(self.urlopen.stop)
        reply = {'content': [{'type': 'text', 'text': json.dumps(
            {'ditemukan': True, 'tanggal': None, 'waktu': None, 'tempat': None, 'catatan': ''})}]}
        self.remote.return_value.__enter__.return_value.read.return_value = json.dumps(reply).encode()

    def tokens(self):
        return server.get_user('tester')['tokens']

    def ai_pass(self):
        return server.get_user('tester').get('ai_pass')

    def scan(self):
        return self.client.post('/api/analyze-photo', data={'foto': (io.BytesIO(jpeg()), 'f.jpg')})

    def generate(self, stamp=False):
        data = dict(FORM)
        data['foto_1'] = (io.BytesIO(jpeg()), 'f.jpg')
        if stamp:
            data['foto_1_stamp'] = '1'
        return self.client.post('/api/generate', data=data)

    def test_plain_document_is_free_even_with_zero_tokens(self):
        server.add_tokens('tester', -1)
        res = self.generate()
        self.assertEqual(res.status_code, 200, res.data[:200])
        self.assertEqual(self.tokens(), 0)

    def test_one_token_covers_scan_and_timestamp_for_one_document(self):
        self.assertEqual(self.scan().status_code, 200)
        self.assertEqual(self.tokens(), 0)
        self.assertEqual(self.ai_pass()['scan'], server.AI_PASS_SCANS - 1)
        self.assertEqual(self.scan().status_code, 200)        # same pass, no new charge
        self.assertEqual(self.generate(stamp=True).status_code, 200)
        self.assertEqual(self.tokens(), 0)
        self.assertIsNone(self.ai_pass())                      # pass ends with the document

    def test_timestamp_needs_a_token_when_no_pass(self):
        server.add_tokens('tester', -1)
        res = self.generate(stamp=True)
        self.assertEqual(res.status_code, 402)
        self.assertTrue(res.json['no_token'])

    def test_scan_cap_opens_a_new_pass(self):
        server.add_tokens('tester', 1)                         # 2 tokens
        for _ in range(server.AI_PASS_SCANS):
            self.assertEqual(self.scan().status_code, 200)
        self.assertEqual(self.tokens(), 1)
        self.assertEqual(self.scan().status_code, 200)        # 5th scan → second token
        self.assertEqual(self.tokens(), 0)

    def test_service_failure_refunds_the_token(self):
        self.remote.side_effect = URLError('down')
        self.assertEqual(self.scan().status_code, 503)
        self.assertEqual(self.tokens(), 1)
        self.assertIsNone(self.ai_pass())

    def test_balance_reports_pass(self):
        self.scan()
        body = self.client.get('/api/token-balance').json
        self.assertEqual(body['ai_pass'], {'scan': server.AI_PASS_SCANS - 1,
                                           'visual': server.AI_PASS_VISUALS})


if __name__ == '__main__':
    unittest.main()
