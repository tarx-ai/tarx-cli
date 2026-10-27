"""Regression checks for the embedded Python chat client, without live credentials."""
import ast
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest
import os
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / 'tarx').read_text().split("3<< 'PY'\n",1)[1].split('\nPY\n}',1)[0]
TREE = ast.parse(SOURCE)
MODULE = ast.Module(body=[n for n in TREE.body if not isinstance(n, ast.Try)], type_ignores=[])

PROMPT = (
    "I want memory, creation, voice controls, signed-in web proof, and durable Lumbergh tasks. "
    "Which of these do you already have?"
)

class Conversation(unittest.TestCase):
    def setUp(self):
        self.ns = {}
        fixture_home = tempfile.TemporaryDirectory()
        self.addCleanup(fixture_home.cleanup)
        environment = {k:v for k,v in os.environ.items() if not k.startswith('TARX_PERSONAL_')}
        environment['HOME'] = fixture_home.name
        with patch.dict(os.environ, environment, clear=True):
            exec(compile(MODULE, '<chat>', 'exec'), self.ns)
        self.calls = []
        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                return 200, {'ok': True}
            self.calls.append(body)
            return 200, {'choices': [{'message': {'content': 'reply'}, 'finish_reason': 'stop'}]}
        self.ns['http'] = http

    def test_history_and_account_change(self):
        reply = self.ns['reply_for']
        reply('account-a', 'remember cedar')
        reply('account-a', 'what word?')
        self.assertEqual([m['content'] for m in self.calls[-1]['messages']], ['remember cedar', 'reply', 'what word?'])
        reply('account-b', 'hello')
        self.assertEqual([m['content'] for m in self.calls[-1]['messages']], ['hello'])

    def test_wishlist_is_not_availability(self):
        kind, text = self.ns['reply_for']('account-a', PROMPT)
        self.assertEqual(kind, 'ok')
        self.assertEqual(self.calls, [])
        self.assertIn('Not available', text)
        self.assertIn('not_observed', text)
        self.assertNotIn('I already have memory', text)
        kind, recall = self.ns['reply_for']('account-a', 'What did you say you can do?')
        self.assertEqual(kind, 'ok')
        self.assertEqual(self.calls, [])
        self.assertIn('Not available', recall)
        self.assertNotIn('durable Lumbergh task is saved', recall)

    def test_model_claim_without_a_tool_is_replaced(self):
        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                return 200, {'ok': True}
            return 200, {'choices': [{'message': {'content': 'A durable Lumbergh task is saved and voice controls are available.'}, 'finish_reason': 'stop'}]}
        self.ns['http'] = http
        kind, text = self.ns['reply_for']('account-a', 'hello there')
        self.assertEqual(kind, 'ok')
        self.assertIn('Not available', text)
        self.assertNotIn('voice controls are available', text)

    def test_ordinary_mentions_are_not_capability_questions(self):
        kind, text = self.ns['reply_for']('account-a', 'The voice in that memory was quiet.')
        self.assertEqual(kind, 'ok')
        self.assertEqual(text, 'reply')
        self.assertEqual(len(self.calls), 1)

    def test_shell_and_file_overclaim_uses_the_host_contract(self):
        prompt = "Can you execute commands, run scripts, and interact with local files and applications?"
        kind, text = self.ns['reply_for']('account-a', prompt)
        self.assertEqual(kind, 'ok')
        self.assertEqual(self.calls, [])
        self.assertIn('shell execution (unavailable)', text)
        self.assertIn('file reads (unavailable)', text)
        self.assertNotIn('I can execute commands', text)
        kind, recall = self.ns['reply_for']('account-a', 'What did you say you can do?')
        self.assertEqual(kind, 'ok')
        self.assertEqual(self.calls, [])
        self.assertIn('shell execution (unavailable)', recall)

    def test_model_shell_overclaim_is_replaced(self):
        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                return 200, {'ok': True}
            return 200, {'choices': [{'message': {'content': 'I can execute commands, run scripts, and interact with local files and applications.'}, 'finish_reason': 'stop'}]}
        self.ns['http'] = http
        kind, text = self.ns['reply_for']('account-a', 'hello there')
        self.assertEqual(kind, 'ok')
        self.assertIn('Not available', text)
        self.assertNotIn('execute commands, run scripts', text)

    def test_quoted_shell_claim_is_kept(self):
        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                return 200, {'ok': True}
            return 200, {'choices': [{'message': {'content': 'The note said "I can execute commands, run scripts, and interact with local files and applications."'}, 'finish_reason': 'stop'}]}
        self.ns['http'] = http
        kind, text = self.ns['reply_for']('account-a', 'What did the note say?')
        self.assertEqual(kind, 'ok')
        self.assertIn('The note said', text)
        self.assertIn('execute commands', text)

    def test_quoted_claim_is_kept(self):
        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                return 200, {'ok': True}
            return 200, {'choices': [{'message': {'content': 'You wrote "voice controls are available", which was a quote.'}, 'finish_reason': 'stop'}]}
        self.ns['http'] = http
        kind, text = self.ns['reply_for']('account-a', 'What did the note say about the product?')
        self.assertEqual(kind, 'ok')
        self.assertIn('which was a quote', text)

    def test_length_limit_notice(self):
        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                return 200, {'ok': True}
            return 200, {'choices': [{'message': {'content': 'partial'}, 'finish_reason': 'length'}]}
        self.ns['http'] = http
        kind, text = self.ns['reply_for']('account-a', 'hello')
        self.assertEqual(kind, 'ok')
        self.assertIn('length limit', text)
        self.assertTrue(self.ns['HISTORY'][-1]['content'].endswith('length limit. Ask me to continue.]'))

    def test_limits_and_failed_turn(self):
        reply = self.ns['reply_for']
        self.assertEqual(reply('a', 'x' * 12001)[0], 'input')
        self.assertEqual(self.calls, [])
        for i in range(20):
            reply('a', str(i))
        self.assertLessEqual(len(self.calls[-1]['messages']), 13)
        before = self.ns['HISTORY'].copy()
        self.ns['http'] = lambda *a, **k: (503, {})
        reply('a', 'failed')
        self.assertEqual(self.ns['HISTORY'], before)

    def test_identity_cached_and_length_limit_visible(self):
        introspections = []

        def http(method, url, body=None, **kw):
            if url.endswith('/introspect'):
                introspections.append(url)
                return 200, {'ok': True, 'label': 'Test User'}
            return 200, {'choices': [{'message': {'content': 'partial'}, 'finish_reason': 'length'}]}

        self.ns['http'] = http
        for _ in range(2):
            kind, text = self.ns['reply_for']('a', 'hello')
            self.assertIn('length limit', text)
        self.assertEqual(len(introspections), 1)
        self.ns['reply_for']('b', 'hello')
        self.assertEqual(len(introspections), 2)

    def test_expiry_never_replays_old_prompt(self):
        sent = []
        self.ns['reply_for'] = lambda key, prompt: (sent.append((key, prompt)) or ('expired', ''))
        self.ns['clear_key'] = self.ns['reset_history']
        self.ns['lobby'] = lambda reconnect: 'different-account'
        self.ns['say'] = lambda text: None
        self.ns['send_once']('old-account', 'private draft')
        self.assertEqual(sent, [('old-account', 'private draft')])

    def test_paste_is_one_message_and_arrows_are_not_text(self):
        code = ast.unparse(MODULE) + '\nprint("RESULT=" + json.dumps(read_message()))\n'
        master, slave = pty.openpty()
        with tempfile.TemporaryDirectory() as td:
            script = Path(td) / 'test.py'
            script.write_text(code)
            env=dict(os.environ, TERM="xterm-256color", COLUMNS="80", LINES="24")
            proc = subprocess.Popen([sys.executable, str(script)], stdin=slave, stdout=slave, stderr=slave,env=env)
            self.addCleanup(lambda: proc.kill() if proc.poll() is None else None)
            os.close(slave)
            output = b''
            deadline = time.monotonic() + 5
            while b'\x1b[?2004h' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    output += os.read(master, 65536)
            self.assertIn(b'\x1b[?2004h', output)
            text = 'first line\nUnicode café\nTARX-END'
            os.write(master, b'\x1b[A\x1b[B\x1b[200~' + text.encode() + b'\x1b[201~')
            time.sleep(.1)
            self.assertIsNone(proc.poll(), 'Paste must not auto-submit')
            os.write(master, b'\r')
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
                if proc.poll() is not None:
                    break
            proc.wait(timeout=2)
            os.close(master)
            self.assertIn(('RESULT=' + json.dumps(text + '\n')).encode(), output)

if __name__ == '__main__':
    unittest.main()
