"""Lupa akun: re-verify with the Google account used at sign-up, then set a new password."""
import os
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlparse, parse_qs

from werkzeug.security import check_password_hash, generate_password_hash

_storage = tempfile.TemporaryDirectory(prefix='lhp-recover-tests-')
with patch.dict(os.environ, {'DATA_DIR': _storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server


class RecoverTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in (('USERS_FILE', os.path.join(tmp.name, 'users.json')),
                            ('_users_cache', {'mtime': None, 'data': None}),
                            ('GOOGLE_CLIENT_ID', 'client-id'),
                            ('GOOGLE_REDIRECT_URI', 'http://localhost/auth/google/callback')):
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        server._save_users({'budi': {'uid': 'budi', 'username': 'budi', 'name': 'BUDI',
                                     'password': generate_password_hash('lama123'),
                                     'google_id': 'g-1', 'google_email': 'budi@example.com',
                                     'tokens': 1}})
        for name, value in (('_google_exchange_code', lambda code: {'access_token': 'x'}),
                            ('_google_userinfo', lambda tok: self.google)):
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.google = {'id': 'g-1', 'email': 'budi@example.com', 'name': 'Budi'}
        self.client = server.app.test_client()

    def start(self, path='/lupa-akun'):
        res = self.client.get(path)
        self.assertEqual(res.status_code, 302)
        return parse_qs(urlparse(res.location).query)['state'][0]

    def callback(self, state):
        return self.client.get(f'/auth/google/callback?code=c&state={state}')

    def test_recover_shows_username_and_resets_password(self):
        res = self.callback(self.start())
        self.assertTrue(res.location.endswith('/lupa-akun/reset'))
        page = self.client.get('/lupa-akun/reset')
        self.assertIn(b'budi', page.data)
        res = self.client.post('/api/recover/reset', json={'password': 'baru456'})
        self.assertTrue(res.json['ok'])
        self.assertTrue(check_password_hash(server.get_user('budi')['password'], 'baru456'))
        self.assertEqual(res.json['redirect'], '/profil')               # first page after login
        self.assertEqual(self.client.get('/profil').status_code, 200)    # logged in
        # one-time: the recovery session is gone
        self.assertEqual(self.client.post('/api/recover/reset', json={'password': 'lagi789'}).status_code, 400)

    def test_wrong_state_is_rejected(self):
        self.start()
        res = self.callback('forged')
        self.assertIn('error=session_expired', res.location)
        self.assertIn('recover_expired', self.client.get('/lupa-akun/reset').location)

    def test_unknown_google_account(self):
        self.google = {'id': 'g-other', 'email': 'x@example.com'}
        res = self.callback(self.start())
        self.assertIn('error=recover_not_found', res.location)

    def test_short_password_and_expiry(self):
        self.callback(self.start())
        self.assertEqual(self.client.post('/api/recover/reset', json={'password': '123'}).status_code, 400)
        with self.client.session_transaction() as s:
            s['recover'] = {**s['recover'], 'exp': time.time() - 1}
        self.assertEqual(self.client.post('/api/recover/reset', json={'password': 'baru456'}).status_code, 400)
        self.assertTrue(check_password_hash(server.get_user('budi')['password'], 'lama123'))

    def test_starts_on_callback_domain(self):
        with patch.object(server, 'GOOGLE_REDIRECT_URI',
                          'https://lhp.up.railway.app/auth/google/callback'):
            for path in ('/lupa-akun', '/register'):
                res = self.client.get(path)
                self.assertEqual(res.location, 'https://lhp.up.railway.app' + path)

    def test_register_flow_still_works(self):
        self.google = {'id': 'g-new', 'email': 'new@example.com', 'name': 'Baru'}
        res = self.callback(self.start('/register'))
        self.assertTrue(res.location.endswith('/register/form'))


if __name__ == '__main__':
    unittest.main()
