"""Offline payment contract and persistence regressions; no provider traffic."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from urllib.error import HTTPError
import io

_import_storage = tempfile.TemporaryDirectory(prefix='lhp-payment-import-')
with patch.dict(os.environ, {'DATA_DIR': _import_storage.name, 'SECRET_KEY': 'test-only'}):
    import app as server


class PaymentTests(unittest.TestCase):
    def setUp(self):
        storage = tempfile.TemporaryDirectory(prefix='lhp-payment-test-')
        self.addCleanup(storage.cleanup)
        self.directory = Path(storage.name)
        for name, value in {
            'USERS_FILE': str(self.directory / 'users.json'),
            'ORDERS_FILE': str(self.directory / 'orders.json'),
            '_users_cache': {'mtime': None, 'data': None},
            'DUITKU_MERCHANT_CODE': 'DTEST', 'DUITKU_API_KEY': 'secret-test-only',
            'DUITKU_ENV': 'sandbox',
            'PUBLIC_BASE_URL': 'https://test.example',
            'DUITKU_BASE_URL': 'https://api-sandbox.duitku.com/api/merchant',
        }.items():
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        server._save_users({'tester': {'uid': 'tester', 'username': 'tester',
            'name': 'Test User', 'tokens': 1, 'google_email': 'test@example.com'}})
        self.client = server.app.test_client()
        with self.client.session_transaction() as session:
            session['uid'] = 'tester'
        p = patch('urllib.request.urlopen')
        self.remote = p.start()
        self.addCleanup(p.stop)
        self.remote.return_value.__enter__.return_value.read.return_value = json.dumps({
            'statusCode': '00', 'reference': 'REF-TEST',
            'paymentUrl': 'https://app-sandbox.duitku.com/checkout/REF-TEST'}).encode()

    def order(self, uid='tester'):
        return server.create_order(uid, 'pkg_5')[0]

    def callback(self, order_id, **changes):
        payload = {'merchantCode': 'DTEST', 'merchantOrderId': order_id,
                   'amount': '25000', 'resultCode': '00'}
        payload.update(changes)
        raw = payload['merchantCode'] + payload['amount'] + payload['merchantOrderId']
        payload['signature'] = hmac.new(b'secret-test-only', raw.encode(), hashlib.sha256).hexdigest()
        return payload

    def notify(self, payload):
        return self.client.post('/api/topup/notification', data=payload)

    def test_checkout_uses_pop_endpoint_headers_and_hosted_method_selection(self):
        with patch.object(server.time, 'time', return_value=1700000000):
            with self.client.session_transaction() as session:
                session['uid'] = 'tester'
            result = self.client.post('/api/topup/create', json={'pkg_id': 'pkg_5'})
        self.assertEqual(result.status_code, 200)
        req = self.remote.call_args.args[0]
        self.assertEqual(req.full_url, 'https://api-sandbox.duitku.com/api/merchant/createInvoice')
        headers = {k.lower(): v for k, v in req.header_items()}
        self.assertEqual(headers['x-duitku-merchantcode'], 'DTEST')
        self.assertEqual(headers['x-duitku-timestamp'], '1700000000000')
        self.assertEqual(headers['x-duitku-signature'], hmac.new(
            b'secret-test-only', b'DTEST1700000000000', hashlib.sha256).hexdigest())
        body = json.loads(req.data)
        self.assertEqual(body['paymentAmount'], 25000)
        self.assertEqual(body['paymentMethod'], '')
        self.assertEqual(body['callbackUrl'], 'https://test.example/api/topup/notification')
        self.assertIn('payment_order=', body['returnUrl'])
        order = server.get_order(result.json['order_id'])
        self.assertEqual(order['reference'], 'REF-TEST')
        self.assertEqual(server.get_user('tester')['tokens'], 1)

    def test_duplicate_concurrent_notifications_credit_once(self):
        order_id = self.order()
        payload = self.callback(order_id)
        def notify(_):
            with server.app.test_client() as client:
                return client.post('/api/topup/notification', data=payload).status_code
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(notify, range(20))), [200] * 20)
        self.assertEqual(server.get_user('tester')['tokens'], 6)
        self.assertEqual(server.get_order(order_id)['status'], 'paid')

    def test_crash_after_credit_before_order_save_is_recoverable_after_restart(self):
        order_id = self.order()
        with patch.object(server, '_save_orders', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                server.complete_order(order_id)
        self.assertEqual(server.get_order(order_id)['status'], 'pending')
        server._users_cache = {'mtime': None, 'data': None}
        self.assertTrue(server.complete_order(order_id))
        self.assertEqual(server.get_user('tester')['tokens'], 6)
        self.assertEqual(server.get_order(order_id)['status'], 'paid')

    def test_failed_account_write_does_not_pollute_cache(self):
        order_id = self.order()
        with patch.object(server, '_write_json_atomic', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                server.complete_order(order_id)
        self.assertEqual(server.get_user('tester')['tokens'], 1)
        self.assertTrue(server.complete_order(order_id))
        self.assertEqual(server.get_user('tester')['tokens'], 6)

    def test_invalid_signature_merchant_amount_reference_and_missing_key_rejected(self):
        order_id = self.order()
        invalid = self.callback(order_id)
        invalid['signature'] = 'invalid'
        self.assertEqual(self.notify(invalid).status_code, 403)
        self.assertEqual(self.notify(self.callback(order_id, merchantCode='OTHER')).status_code, 403)
        self.assertEqual(self.notify(self.callback(order_id, amount='1')).status_code, 400)
        server.update_order(order_id, reference='EXPECTED')
        self.assertEqual(self.notify(self.callback(order_id, reference='OTHER')).status_code, 400)
        with patch.object(server, 'DUITKU_API_KEY', ''):
            self.assertEqual(self.notify(self.callback(order_id)).status_code, 503)
            self.assertEqual(self.client.post('/api/topup/create', json={'pkg_id':'pkg_5'}).status_code, 503)
        self.assertEqual(server.get_user('tester')['tokens'], 1)

    def test_public_site_rejects_sandbox_or_unspecified_environment(self):
        with patch.object(server, 'PUBLIC_BASE_URL', 'https://lhpakpol.co'):
            self.assertEqual(self.client.post('/api/topup/create', json={'pkg_id':'pkg_5'}).status_code, 503)
        with patch.object(server, 'DUITKU_ENV', ''):
            self.assertEqual(self.client.post('/api/topup/create', json={'pkg_id':'pkg_5'}).status_code, 503)
        self.remote.assert_not_called()

    def test_late_failure_cannot_downgrade_paid_order(self):
        order_id = self.order()
        self.assertEqual(self.notify(self.callback(order_id)).status_code, 200)
        self.assertEqual(self.notify(self.callback(order_id, resultCode='01')).status_code, 200)
        self.assertEqual(server.get_order(order_id)['status'], 'paid')
        self.assertEqual(server.get_user('tester')['tokens'], 6)

    def test_paid_legacy_order_is_not_credited_again(self):
        order_id = self.order()
        server.update_order(order_id, status='paid')
        self.assertTrue(server.complete_order(order_id))
        self.assertEqual(server.get_user('tester')['tokens'], 1)

    def test_corrupt_orders_and_users_fail_closed(self):
        order_id = self.order()
        Path(server.USERS_FILE).write_text('{broken')
        server._users_cache = {'mtime': None, 'data': None}
        with self.assertRaises(json.JSONDecodeError):
            server.complete_order(order_id)
        self.assertEqual(server.get_order(order_id)['status'], 'pending')
        Path(server.ORDERS_FILE).write_text('{broken')
        with self.assertRaises(json.JSONDecodeError):
            self.order()
        self.assertEqual(Path(server.ORDERS_FILE).read_text(), '{broken')

    def test_order_status_is_private_and_missing_account_is_not_acknowledged(self):
        order_id = self.order('someone-else')
        self.assertEqual(self.client.get('/api/topup/status/' + order_id).status_code, 404)
        self.assertEqual(self.notify(self.callback(order_id)).status_code, 503)
        self.assertEqual(server.get_order(order_id)['status'], 'pending')
        self.assertEqual(self.notify(self.callback('unknown')).status_code, 404)
        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.post('/api/topup/create', json={'pkg_id':'pkg_5'}).status_code, 401)

    def test_concurrent_order_creation_preserves_all_orders(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(lambda _: self.order(), range(20)))
        self.assertEqual(set(server._load_orders()), set(ids))

    def test_malformed_callback_and_provider_failures_do_not_credit(self):
        self.assertEqual(self.client.post('/api/topup/notification', json=[]).status_code, 403)
        self.assertEqual(self.client.post('/api/topup/create', json=[]).status_code, 400)
        for reply in ({'statusCode': '01'}, {'statusCode': '00', 'reference': 'x',
                'paymentUrl': 'https://evil.example/checkout'}):
            self.remote.return_value.__enter__.return_value.read.return_value = json.dumps(reply).encode()
            self.assertEqual(self.client.post('/api/topup/create', json={'pkg_id':'pkg_5'}).status_code, 502)
        self.assertEqual(server.get_user('tester')['tokens'], 1)

    def test_provider_http_failure_marks_order_failed_and_redacts_secret(self):
        self.remote.side_effect = HTTPError('https://api-sandbox.duitku.com',
            500, 'error', {}, io.BytesIO(b'failed secret-test-only'))
        with self.assertLogs(server.app.logger, level='ERROR') as logs:
            response = self.client.post('/api/topup/create', json={'pkg_id':'pkg_5'})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn('secret-test-only', str(logs.output))
        self.assertIn('[redacted]', str(logs.output))
        self.assertEqual(server.get_user('tester')['tokens'], 1)
        self.assertEqual(list(server._load_orders().values())[0]['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
