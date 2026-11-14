"""Taruna Visual relay contract without paid provider traffic."""
import base64
from io import BytesIO
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

with tempfile.TemporaryDirectory() as storage, patch.dict(os.environ, {'DATA_DIR': storage, 'SECRET_KEY': 'test-only'}):
    import app as server


class TarunaVisualTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
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
            response = remote.return_value.__enter__.return_value
            response.read.return_value = json.dumps(image).encode()
            response.status = 200
            result = self.client.post('/api/taruna-visual/generate', json=self.payload)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json['image']['mimeType'], 'image/jpeg')
            with Image.open(BytesIO(base64.b64decode(result.json['image']['data']))) as stamped:
                self.assertEqual(stamped.size, (400, 300))
                self.assertLess(max(stamped.getpixel((5, 290))), 50)
            request = remote.call_args.args[0]
            self.assertEqual(request.full_url, 'https://taruna-visual-production-04a8.up.railway.app/api/generate')
            self.assertIsNone(request.get_header('Origin'))


if __name__ == '__main__':
    unittest.main()
