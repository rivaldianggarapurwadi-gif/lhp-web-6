"""Every documentation photo loses its top tenth before LHP use (bottom is kept)."""
import base64
import io
import json
import os
import re
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from PIL import Image

_storage = tempfile.TemporaryDirectory(prefix='lhp-crop-tests-')
with patch.dict(os.environ, {'DATA_DIR': _storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server

FORM = {'Nama': 'BUDI', 'No Ak': '123', 'Pangkat': 'BHAYANGKARA TARUNA', 'Tingkat': '2',
        'Peleton': '1', 'Kompi': '2', 'Nama Danton': 'A', 'Pangkat Danton': 'IPDA',
        'NRP Danton': '1', 'Nama Danki': 'B', 'Pangkat Danki': 'AKP', 'NRP Danki': '2',
        'Nama Kegiatan': 'OLAHRAGA', 'Tanggal Kegiatan': 'MINGGU, 17 MEI 2026',
        'Waktu Kegiatan': '08.00 WIB', 'Tempat Kegiatan': 'LAPANGAN'}


def striped_photo():
    """400x300 white photo with colored 30 px strips at the top and bottom."""
    im = Image.new('RGB', (400, 300), 'white')
    im.paste((255, 0, 0), (0, 0, 400, 30))
    im.paste((0, 0, 255), (0, 270, 400, 300))
    out = io.BytesIO()
    im.save(out, 'PNG')
    return out.getvalue()


class PhotoCropTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        with self.client.session_transaction() as session:
            session['uid'] = 'crop-test'
        p = patch.object(server, 'end_ai_pass', lambda uid: None)
        p.start()
        self.addCleanup(p.stop)

    def doc_photos(self, docx_bytes):
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as z:
            names = [n for n in z.namelist() if n.startswith('word/media/')]
            imgs = [Image.open(io.BytesIO(z.read(n))).convert('RGB') for n in names]
        return [im for im in imgs if im.size[0] == 400]           # skip the template logo

    def test_only_top_tenth_is_cropped_in_document(self):
        data = dict(FORM, foto_1=(io.BytesIO(striped_photo()), 'f.png'))
        res = self.client.post('/api/generate', data=data)
        self.assertEqual(res.status_code, 200, res.data[:200])
        (photo,) = self.doc_photos(res.data)
        self.assertEqual(photo.size, (400, 270))
        self.assertGreater(min(photo.getpixel((200, 1))), 200, 'red top strip should be gone')
        r, g, b = photo.getpixel((200, 268))
        self.assertTrue(b > 200 and r < 60, 'blue bottom strip should stay')

    def test_timestamp_is_added_after_crop(self):
        data = dict(FORM, foto_1=(io.BytesIO(striped_photo()), 'f.png'), foto_1_stamp='1')
        with patch.object(server, 'consume_ai', return_value=(True, {'undo': None})):
            res = self.client.post('/api/generate', data=data)
        self.assertEqual(res.status_code, 200, res.data[:200])
        (photo,) = self.doc_photos(res.data)
        self.assertEqual(photo.size, (400, 270))
        self.assertLess(max(photo.getpixel((10, 250))), 180, 'timestamp background should remain')

    def test_preview_uses_the_same_cropped_photo(self):
        data = dict(FORM, foto_1=(io.BytesIO(striped_photo()), 'f.png'))
        res = self.client.post('/api/preview', data=data)
        self.assertEqual(res.status_code, 200, res.data[:200])
        images = re.findall(r'data:image/jpeg;base64,([A-Za-z0-9+/=]+)', res.json['html'])
        photos = [Image.open(io.BytesIO(base64.b64decode(image))) for image in images]
        self.assertIn((400, 270), [photo.size for photo in photos])

    def test_crop_failure_keeps_original(self):
        bad = os.path.join(_storage.name, 'not-an-image.jpg')
        with open(bad, 'wb') as f:
            f.write(b'nope')
        self.assertEqual(server._crop_documentation_photo(bad), bad)


class SyncThread:
    def __init__(self, target, daemon=None):
        self.target = target
    def start(self):
        self.target()


class ReferenceForwardTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        with self.client.session_transaction() as session:
            session['uid'] = 'crop-test'
        for obj, name, value in ((server, 'end_ai_pass', lambda uid: None),
                                 (server, 'TARUNA_VISUAL_REF_TOKEN', 'ref-secret'),
                                 (server.threading, 'Thread', SyncThread)):
            p = patch.object(obj, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.urlopen = patch('urllib.request.urlopen')
        self.remote = self.urlopen.start()
        self.addCleanup(self.urlopen.stop)

    def generate(self, share, names=('f.png',)):
        data = dict(FORM)
        for i, name in enumerate(names, 1):
            data[f'foto_{i}'] = (io.BytesIO(striped_photo()), name)
        if share:
            data['share_refs'] = '1'
        res = self.client.post('/api/generate', data=data)
        self.assertEqual(res.status_code, 200, res.data[:200])

    def test_nothing_sent_without_consent(self):
        self.generate(share=False)
        self.remote.assert_not_called()

    def test_nothing_sent_without_token(self):
        with patch.object(server, 'TARUNA_VISUAL_REF_TOKEN', ''):
            self.generate(share=True)
        self.remote.assert_not_called()

    def test_sends_cropped_user_photos_only(self):
        self.generate(share=True, names=('f.png', 'taruna-visual-2.jpg'))
        req = self.remote.call_args.args[0]
        self.assertTrue(req.full_url.endswith('/api/references'))
        self.assertEqual(req.get_header('X-lhp-token'), 'ref-secret')
        body = json.loads(req.data)
        self.assertTrue(body['consent'])
        self.assertEqual(len(body['photos']), 1)                  # AI photo not sent back
        sent = Image.open(io.BytesIO(base64.b64decode(body['photos'][0]['data'])))
        self.assertEqual(sent.size, (400, 270))                   # already cropped
        self.assertEqual(body['meta']['kegiatan'], 'OLAHRAGA')
        self.assertNotIn('BUDI', req.data.decode())               # no name/NRP


if __name__ == '__main__':
    unittest.main()
