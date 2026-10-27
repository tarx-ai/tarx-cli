"""Exercise actual embedded CLI functions with fixture authority; no model/network."""
import ast
from pathlib import Path
import unittest
import os
from unittest.mock import patch
import tempfile

source = (Path(__file__).resolve().parent.parent / 'tarx').read_text().split("3<< 'PY'\n", 1)[1].split('\nPY\n', 1)[0]
tree = ast.parse(source)
# Load actual declarations, excluding only the final main() execution.
module = ast.Module(body=[n for n in tree.body if not isinstance(n, ast.Try)], type_ignores=[])

class AuthTests(unittest.TestCase):
    def setUp(self):
        self.ns = {}
        fixture_home = tempfile.TemporaryDirectory()
        self.addCleanup(fixture_home.cleanup)
        environment = {k:v for k,v in os.environ.items() if not k.startswith('TARX_PERSONAL_')}
        environment['HOME'] = fixture_home.name
        with patch.dict(os.environ, environment, clear=True):
            exec(compile(module, '<tarx-chat>', 'exec'), self.ns)
        self.tmp = tempfile.TemporaryDirectory()
        self.ns['KEY_PATH'] = Path(self.tmp.name) / 'chat-key'
        self.ns['os'].environ.pop('TARX_CHAT_KEY', None)
        self.ns['KEY_PATH'].write_text('fixture-key')
        self.lines, self.calls, self.messages = [], [], []
        self.ns['say'] = self.messages.append
        self.ns['show_commands'] = lambda: None
        self.ns['read_message'] = lambda: self.lines.pop(0) if self.lines else ''
        self.ns['send_once'] = lambda *_: self.fail('auth or slash intent reached inference')
        self.ns['http'] = self.http
        self.status, self.body = 200, {'ok': True, 'subject_id': 'tvs_' + 'a'*32}
        self.ns['begin_sign_in'] = lambda: self.calls.append(('begin',))
    def tearDown(self):
        self.tmp.cleanup()
    def http(self, method, url, body=None, **kwargs):
        self.calls.append((method, url, body))
        return self.status, self.body
    def run_lines(self, *lines):
        self.lines = list(lines)
        self.ns['loop']()
    def test_auth_aliases_never_reach_model(self):
        for alias in ('signin','sign-in','sign in','login','log-in','log in'):
            for prefix in ('','/'):
                self.calls.clear()
                self.run_lines(prefix + alias)
                self.assertEqual(len(self.calls),1)
                self.assertEqual(self.calls[0][2]['spend'],False)
                self.assertIn('already connected',self.messages[-1])
    def test_signout_aliases_revoke_once_and_clear(self):
        for alias in ('signout','sign-out','sign out','logout','log-out','log out'):
            for prefix in ('','/'):
                self.ns['KEY_PATH'].write_text('fixture-key')
                self.calls.clear()
                self.run_lines(prefix + alias)
                self.assertEqual(len(self.calls),1)
                self.assertTrue(self.calls[0][1].endswith('/cli/revoke'))
                self.assertFalse(self.ns['KEY_PATH'].exists())
    def test_stale_signin_reauths_not_connected(self):
        for status,body in ((401,{}),(200,{'ok':True}),(200,{'ok':True,'subject_id':'tjs_'+'a'*32})):
            self.status,self.body = status,body
            self.calls.clear();self.messages.clear()
            self.run_lines('/signin')
            self.assertEqual(self.calls[-1],('begin',))
            self.assertNotIn('already connected',' '.join(self.messages))
    def test_authority_down_preserves_credential(self):
        self.status,self.body=503,{}
        self.run_lines('/signin','/signout')
        self.assertTrue(self.ns['KEY_PATH'].exists())
        self.assertFalse(any(c==('begin',) for c in self.calls))
        self.assertIn('unchanged',' '.join(self.messages))
    def test_unknown_slash_is_local(self):
        self.run_lines('/something new')
        self.assertEqual(self.calls,[])
        self.assertIn('No message was sent',self.messages[-1])
    def test_signout_without_key_no_revoke(self):
        self.ns['KEY_PATH'].unlink()
        self.run_lines('/signout')
        self.assertEqual(self.calls,[])
    def test_device_link_is_canonical_and_code_preserved(self):
        self.ns['AUTH']='https://tarx.com'
        self.assertEqual(self.ns['approval_url']('AB12CD34','https://tarx.com/auth/device?code=AB12CD34'), 'https://www.tarx.com/agent?cli=AB12CD34')
        self.assertEqual(self.ns['approval_url']('bad','https://tarx.com/auth/device?code=bad'),'')
        self.assertEqual(self.ns['approval_url']('AB12CD34','https://evil.example/auth/device?code=AB12CD34'),'')
    def test_existing_commands_stay_local(self):
        self.run_lines('/agents','/channels','/help')
        self.assertEqual(self.calls,[])

if __name__ == '__main__': unittest.main()
