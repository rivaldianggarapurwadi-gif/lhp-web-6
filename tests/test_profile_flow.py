"""Profil → pilih mode → form LHP gratis/token, plus saved face/body photos for Taruna Visual."""
import base64
import io
import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from PIL import Image
from werkzeug.security import generate_password_hash

_storage = tempfile.TemporaryDirectory(prefix='lhp-profile-tests-')
with patch.dict(os.environ, {'DATA_DIR': _storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server


def jpeg(color='white', size=(300, 400)):
    out = io.BytesIO()
    Image.new('RGB', size, color).save(out, 'JPEG')
    return out.getvalue()


class ProfileFlowTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in (('USERS_FILE', os.path.join(tmp.name, 'users.json')),
                            ('PROFILES_DIR', os.path.join(tmp.name, 'profiles')),
                            ('_users_cache', {'mtime': None, 'data': None})):
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        server._save_users({'budi': {'uid': 'budi', 'username': 'budi', 'name': 'Budi',
                                     'password': generate_password_hash('rahasia1'), 'tokens': 1,
                                     'last_regen': '2999-01-01T00:00:00+00:00'}})
        self.client = server.app.test_client()

    def login(self):
        return self.client.post('/login', json={'username': 'budi', 'password': 'rahasia1'})

    def save(self, consent=True, **photos):
        data = {'nama': 'budi santoso', 'tingkat': '2', 'pangkat': 'BRIGADIR TARUNA',
                'peleton': '2', 'kompi': '1', 'no_ak': '20230001'}
        if consent:
            data['photo_consent'] = '1'
        for kind, raw in photos.items():
            data['photo_' + kind] = (io.BytesIO(raw), kind + '.jpg')
        return self.client.post('/api/profil', data=data)

    def test_login_goes_to_profile_then_choice(self):
        self.assertEqual(self.login().json['redirect'], '/profil')
        self.assertEqual(self.client.get('/profil').status_code, 200)
        self.assertTrue(self.client.get('/').location.endswith('/pilih'))
        page = self.client.get('/pilih').data.decode()
        self.assertIn('LHP gratis', page)
        self.assertIn('LHP dengan token', page)

    def test_free_mode_hides_ai_and_token_mode_shows_it(self):
        self.login()
        self.save()
        free = self.client.get('/?mode=gratis').data.decode()
        self.assertNotIn('id="visual-generator"', free)
        self.assertNotIn('foto_1_stamp', free)
        self.assertNotIn('id="btn-analyze"', free)
        self.assertIn('value="BUDI SANTOSO"', free)                 # prefilled from profile
        self.assertIn('value="20230001"', free)
        token = self.client.get('/?mode=token').data.decode()
        self.assertIn('id="visual-generator"', token)
        self.assertIn('foto_1_stamp', token)
        self.assertIn('id="btn-analyze"', token)
        paid = self.client.get('/?payment_order=LHP-1').data.decode()
        self.assertIn('id="visual-generator"', paid)              # back from Duitku → token mode

    def test_profile_fields_saved_uppercase(self):
        self.login()
        self.assertEqual(self.save().status_code, 200)
        prof = server.get_user('budi')['profile']
        self.assertEqual(prof['nama'], 'BUDI SANTOSO')
        self.assertEqual((prof['tingkat'], prof['peleton'], prof['kompi']), ('2', '2', '1'))
        self.assertNotIn('photo_consent_at', prof)                # no photos uploaded

    def test_photos_need_consent_and_can_be_deleted(self):
        self.login()
        self.assertEqual(self.save(consent=False, front=jpeg()).status_code, 400)
        res = self.save(front=jpeg(), body=jpeg('blue'))
        self.assertEqual(res.json['photos'], ['front', 'body'])
        self.assertEqual(self.client.get('/profil/foto/front').status_code, 200)
        self.assertIn('no-store', self.client.get('/profil/foto/front').headers['Cache-Control'])
        self.client.post('/api/profil/hapus-foto', json={'kind': 'all'})
        self.assertEqual(self.client.get('/profil/foto/front').status_code, 404)

    def test_bad_values_rejected(self):
        self.login()
        res = self.client.post('/api/profil', data={'pangkat': 'JENDERAL'})
        self.assertEqual(res.status_code, 400)
        res = self.client.post('/api/profil', data={'peleton': 'dua'})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.get('/profil/foto/../users').status_code, 404)

    def test_taruna_visual_uses_saved_photos(self):
        self.login()
        payload = {'level': 2, 'sar': False, 'activity': 'class', 'location': 'Ruang kelas',
                   'ratio': '4:5', 'frame': 'half_body', 'consent': True, 'name': ''}
        res = self.client.post('/api/taruna-visual/generate', json=payload)
        self.assertEqual(res.status_code, 400)
        self.assertTrue(res.json['need_profile'])
        self.save(front=jpeg(), left=jpeg(), right=jpeg(), body=jpeg('blue'))
        out = io.BytesIO(); Image.new('RGB', (40, 50)).save(out, 'PNG')
        reply = MagicMock()
        reply.__enter__.return_value = reply
        reply.read.return_value = json.dumps({'image': {'mimeType': 'image/png',
                                                        'data': base64.b64encode(out.getvalue()).decode()}}).encode()
        with patch('urllib.request.urlopen', return_value=reply) as remote:
            res = self.client.post('/api/taruna-visual/generate', json=payload)
        self.assertEqual(res.status_code, 200, res.data[:200])
        sent = json.loads(remote.call_args.args[0].data)
        self.assertEqual(len(sent['photos']), 3)
        self.assertIn('bodyPhoto', sent)
        self.assertEqual(sent['name'], 'BUDI SANTOSO')

    def test_deleting_account_removes_photos(self):
        self.login()
        self.save(front=jpeg())
        folder = server._profile_dir('budi')
        self.assertTrue(os.path.isdir(folder))
        server.delete_user('budi')
        self.assertFalse(os.path.exists(folder))


if __name__ == '__main__':
    unittest.main()
