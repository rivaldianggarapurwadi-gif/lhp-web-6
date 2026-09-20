"""Offline regressions: python -m unittest discover -s tests -v."""
import base64
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from PIL import Image

# Import with disposable storage, never an existing users.json.
_storage = tempfile.TemporaryDirectory(prefix='lhp-scan-tests-')
with patch.dict(os.environ, {'DATA_DIR': _storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server


def photo(fmt='PNG', size=(80, 60), mode='RGB', **save_args):
    output = io.BytesIO()
    Image.new(mode, size).save(output, format=fmt, **save_args)
    return output.getvalue()


class TimestampScanTests(unittest.TestCase):
    def setUp(self):
        self.key = patch.object(server, 'ANTHROPIC_API_KEY', 'test-key-never-sent')
        self.key.start()
        self.addCleanup(self.key.stop)
        self.client = server.app.test_client()
        with self.client.session_transaction() as session:
            session['uid'] = 'scan-test'
        self.urlopen = patch('urllib.request.urlopen')
        self.remote = self.urlopen.start()
        self.addCleanup(self.urlopen.stop)
        response = {'content': [{'type': 'text', 'text': json.dumps({
            'ditemukan': True, 'tanggal': 'MINGGU, 20 SEPTEMBER 2026',
            'waktu': '08.00 WIB', 'tempat': None, 'catatan': 'Terbaca'})}]}
        self.remote.return_value.__enter__.return_value.read.return_value = json.dumps(response).encode()

    def scan(self, content=None, name='photo.jpg'):
        return self.client.post('/api/analyze-photo', data={
            'foto': (io.BytesIO(photo() if content is None else content), name)})

    def request_image(self):
        request = self.remote.call_args.args[0]
        payload = json.loads(request.data)
        source = payload['messages'][0]['content'][0]['source']
        self.assertEqual(source['media_type'], 'image/jpeg')
        self.assertLessEqual(len(source['data']), 4 * 1024 * 1024)
        image = Image.open(io.BytesIO(base64.b64decode(source['data'])))
        self.assertEqual(image.format, 'JPEG')
        self.assertEqual(image.mode, 'RGB')
        return image

    def provider_error(self, status, message, raw=None):
        body = raw if raw is not None else json.dumps({
            'error': {'type': 'invalid_request_error', 'message': message}}).encode()
        self.remote.side_effect = HTTPError('https://api.anthropic.com/v1/messages',
            status, 'rejected', {'request-id': 'req_test'}, io.BytesIO(body))

    def test_mislabeled_png_is_sent_as_real_jpeg(self):
        response = self.scan(photo('PNG'), 'camera.jpg')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['result']['ditemukan'])
        self.assertEqual(self.request_image().size, (80, 60))

    def test_large_image_is_resized_before_provider_call(self):
        self.assertEqual(self.scan(photo(size=(8100, 100))).status_code, 200)
        self.assertEqual(self.request_image().width, 1568)

    def test_orientation_is_applied(self):
        exif = Image.Exif()
        exif[274] = 6
        self.scan(photo('JPEG', exif=exif))
        self.assertEqual(self.request_image().size, (60, 80))

    def test_transparent_image_has_white_background(self):
        self.scan(photo(mode='RGBA'))
        self.assertEqual(self.request_image().getpixel((0, 0)), (255, 255, 255))

    def test_webp_and_cmyk_are_normalized(self):
        for fmt, mode in [('WEBP', 'RGB'), ('JPEG', 'CMYK')]:
            with self.subTest(fmt=fmt):
                self.assertEqual(self.scan(photo(fmt, mode=mode)).status_code, 200)
                self.request_image()

    def test_invalid_image_and_failed_heic_decode_never_reach_provider(self):
        for name in ('broken.jpg', 'broken.heic'):
            with self.subTest(name=name):
                response = self.scan(b'not an image', name)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json['code'], 'invalid_photo')
        self.remote.assert_not_called()

    @unittest.skipUnless(server._HEIC_OK, 'pillow-heif unavailable')
    def test_real_heic_is_converted(self):
        import pillow_heif
        output = io.BytesIO()
        pillow_heif.from_pillow(Image.new('RGB', (80, 60))).save(output)
        self.assertEqual(self.scan(output.getvalue(), 'camera.heic').status_code, 200)
        self.request_image()

    def test_billing_400_explains_service_balance(self):
        for message in ('Your credit balance is too low to access the Anthropic API.',
                        'You have reached your workspace spend limit.'):
            with self.subTest(message=message):
                self.provider_error(400, message)
                response = self.scan()
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json['code'], 'scan_billing_unavailable')
                self.assertNotIn('API_KEY', response.json['error'])

    def test_image_rejection_does_not_blame_key(self):
        self.provider_error(400, 'Could not process image')
        response = self.scan()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json['code'], 'scan_image_rejected')

    def test_access_rate_limit_and_unknown_errors(self):
        for status, expected in [(401, 'scan_access_unavailable'),
                                 (403, 'scan_access_unavailable'),
                                 (429, 'scan_temporarily_unavailable'),
                                 (529, 'scan_temporarily_unavailable'),
                                 (400, 'scan_request_rejected')]:
            with self.subTest(status=status):
                self.provider_error(status, 'provider diagnostic test-key-never-sent')
                with self.assertLogs(server.app.logger, level='ERROR') as logs:
                    response = self.scan()
                self.assertEqual(response.json['code'], expected)
                self.assertNotIn('test-key-never-sent', str(logs.output))
                self.assertIn('req_test', str(logs.output))
                self.assertNotIn('provider diagnostic', response.json['error'])

    def test_non_json_error_body_and_connection_failure(self):
        self.provider_error(503, '', raw=b'<html>Unavailable</html>')
        self.assertEqual(self.scan().json['code'], 'scan_temporarily_unavailable')
        self.remote.side_effect = URLError('offline')
        self.assertEqual(self.scan().status_code, 503)

    def test_auth_and_missing_configuration_do_not_call_provider(self):
        with patch.object(server, 'ANTHROPIC_API_KEY', ''):
            self.assertEqual(self.scan().status_code, 503)
        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.scan().status_code, 401)
        self.remote.assert_not_called()


if __name__ == '__main__':
    unittest.main()
