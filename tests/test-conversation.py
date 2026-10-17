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

if __name__ == '__main__':
    unittest.main()
