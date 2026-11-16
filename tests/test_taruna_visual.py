"""Taruna Visual relay contract without paid provider traffic."""
import base64
from io import BytesIO
import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from PIL import Image

with tempfile.TemporaryDirectory() as storage, patch.dict(os.environ, {'DATA_DIR': storage, 'SECRET_KEY': 'test-only'}):
    import app as server


class TarunaVisualTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        # Penagihan token diuji di test_ai_tokens.py; di sini cukup kontrak layanannya.
        for name, fake in (('consume_ai', lambda uid, kind: (True, {'charged': False, 'undo': (kind, False, None)})),
                           ('release_ai', lambda uid, undo: None)):
            p = patch.object(server, name, fake)
            p.start()
            self.addCleanup(p.stop)
        self.payload = {'name': 'BUDI', 'level': 2, 'sar': False, 'activity': 'class',
                        'location': 'Ruang kelas', 'ratio': '4:5', 'frame': 'half_body',
                        'consent': True, 'photos': [{'mimeType': 'image/jpeg',
                            'data': base64.b64encode(b'face').decode()}]}

    def test_requires_login_and_consent(self):
        self.assertEqual(self.client.post('/api/taruna-visual/generate', json=self.payload).status_code, 401)
        with self.client.session_transaction() as session:
            session['uid'] = 'tester'
        with patch('urllib.request.urlopen') as remote:
            self.assertEqual(self.client.post('/api/taruna-visual/generate',
                json={**self.payload, 'consent': False}).status_code, 400)
            remote.assert_not_called()

    def test_relays_generated_image_for_documentation(self):
        with self.client.session_transaction() as session:
            session['uid'] = 'tester'
        source = BytesIO()
        Image.new('RGB', (400, 300), 'white').save(source, 'PNG')
        image = {'image': {'mimeType': 'image/png', 'data': base64.b64encode(source.getvalue()).decode()}}
        with patch('urllib.request.urlopen') as remote:
            response = remote.return_value
            response.__enter__.return_value = response
            response.read.return_value = json.dumps(image).encode()
            response.status = 200
            result = self.client.post('/api/taruna-visual/generate', json=self.payload)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json['image']['mimeType'], 'image/jpeg')
            generated = base64.b64decode(result.json['image']['data'])
            with Image.open(BytesIO(generated)) as photo:
                self.assertEqual(photo.size, (400, 300))
                for y in (5, 45, 290):
                    self.assertGreater(min(photo.getpixel((5, y))), 200)
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, 'generated.jpg')
                with open(path, 'wb') as image_file:
                    image_file.write(generated)
                cropped = server._crop_documentation_photo(path)
                with Image.open(cropped) as documentation:
                    self.assertEqual(documentation.size, (400, 270))
                    self.assertGreater(min(documentation.getpixel((5, 15))), 200)
            request = remote.call_args.args[0]
            self.assertEqual(request.full_url, 'https://taruna-visual-production-04a8.up.railway.app/api/generate')
            self.assertIsNone(request.get_header('Origin'))

    def test_retries_legacy_same_origin_rejection(self):
        with self.client.session_transaction() as session:
            session['uid'] = 'tester'
        source = BytesIO()
        Image.new('RGB', (400, 300), 'white').save(source, 'PNG')
        image = {'image': {'mimeType': 'image/png', 'data': base64.b64encode(source.getvalue()).decode()}}
        rejection = HTTPError('https://taruna-visual-production-04a8.up.railway.app/api/generate',
                              403, 'Forbidden', {}, BytesIO(b'{"error":"Same origin required"}'))
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(image).encode()
        with patch('urllib.request.urlopen', side_effect=[rejection, response]) as remote:
            result = self.client.post('/api/taruna-visual/generate', json=self.payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['image']['mimeType'], 'image/jpeg')
        self.assertEqual(remote.call_count, 2)
        self.assertIsNone(remote.call_args_list[0].args[0].get_header('Origin'))
        self.assertEqual(remote.call_args_list[1].args[0].get_header('Origin'),
                         'https://taruna-visual-production-04a8.up.railway.app')


class VisualActivitiesTests(unittest.TestCase):
    """The AI-photo activity list follows Taruna Visual GET /api/activities."""
    def setUp(self):
        p = patch.dict(server._visual_activities, {'data': None, 'at': 0.0, 'refreshing': False})
        p.start()
        self.addCleanup(p.stop)

    def fetch(self, body):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(body).encode()
        with patch('urllib.request.urlopen', return_value=response) as remote:
            server._refresh_visual_activities()
        self.assertTrue(remote.call_args.args[0].endswith('/api/activities'))

    def test_uses_remote_list(self):
        self.fetch({'activities': [{'id': 'imam_solat', 'name': 'Imam salat', 'locations': ['Akpol']}]})
        with patch.object(server.threading, 'Thread'):
            self.assertEqual([a['id'] for a in server.visual_activities()], ['imam_solat'])

    def test_bad_remote_data_keeps_fallback(self):
        self.fetch({'activities': [{'id': 'x', 'name': 'X', 'locations': []}]})
        with patch.object(server.threading, 'Thread'):
            self.assertIs(server.visual_activities(), server.TARUNA_VISUAL_ACTIVITIES_FALLBACK)

    def test_page_never_waits_for_remote(self):
        with patch.object(server.threading, 'Thread') as thread:
            self.assertIs(server.visual_activities(), server.TARUNA_VISUAL_ACTIVITIES_FALLBACK)
        thread.return_value.start.assert_called_once()

    def test_fallback_has_no_retired_activities(self):
        ids = {a['id'] for a in server.TARUNA_VISUAL_ACTIVITIES_FALLBACK}
        self.assertTrue({'culture', 'imam_solat', 'teach_juniors'} <= ids)
        self.assertFalse({'saron', 'gong', 'wayang', 'bonang'} & ids)


if __name__ == '__main__':
    unittest.main()
