"""Composer geometry, truthful per-turn route labels, brand blue, and privacy
boundaries on the real embedded CLI module. No live model, credential, install
or external network: a loopback fixture or mocked http() is used, and the PTY
test runs the real read_message with bounded timeouts and owned cleanup.
"""
import ast
import copy
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
from unittest.mock import patch

CLI = Path(__file__).resolve().parents[1] / 'tarx'
RAW = CLI.read_text().split("3<< 'PY'\n", 1)[1].split('\nPY\n}', 1)[0]
TREE = ast.parse(RAW)
MODULE = ast.Module(body=[n for n in TREE.body if not isinstance(n, ast.Try)], type_ignores=[])
CLOUD = 'tarx_cli_' + 'a' * 64
PERSONAL_KEYS = ['TARX_PERSONAL_RUNTIME_URL', 'TARX_PERSONAL_RUNTIME_KEY', 'TARX_PERSONAL_RUNTIME_MODEL', 'TARX_CHAT_KEY', 'TARX_CHAT_TEXT']


def load(env=None):
    clean = {k: v for k, v in os.environ.items() if k not in PERSONAL_KEYS}
    home = tempfile.mkdtemp()
    clean['HOME'] = home
    clean.update(env or {})
    with patch.dict(os.environ, clean, clear=True):
        ns = {}
        exec(compile(MODULE, '<composer-route>', 'exec'), ns)
        return ns


class RouteLabel(unittest.TestCase):
    def test_route_names_are_three_honest_values(self):
        ns = load()
        self.assertEqual(ns['route_name']('personal'), 'This computer')
        self.assertEqual(ns['route_name']('supercomputer'), 'Supercomputer')
        # Anything not runnable fails closed to Unavailable (no fake Private).
        self.assertEqual(ns['route_name']('personal_misconfigured'), 'Unavailable')
        self.assertEqual(ns['route_name']('anything-else'), 'Unavailable')

    def test_actual_route_from_outcome_fails_closed(self):
        ns = load()
        self.assertEqual(ns['actual_route']('ok', 'supercomputer'), 'Supercomputer')
        self.assertEqual(ns['actual_route']('ok', 'personal'), 'This computer')
        for bad in ('down', 'busy', 'expired', 'input'):
            self.assertEqual(ns['actual_route'](bad, 'supercomputer'), 'Unavailable')
            self.assertEqual(ns['actual_route'](bad, 'personal'), 'Unavailable')

    def test_no_privacy_word_in_route_labels(self):
        ns = load()
        for mode in ('personal', 'supercomputer', 'personal_misconfigured'):
            self.assertNotIn('Private', ns['route_name'](mode))
            self.assertNotIn('PRIVATE', ns['route_name'](mode))

    def test_render_route_prints_actual_and_does_not_relabel_old_turns(self):
        ns = load()
        out = []
        ns['say'] = out.append
        ns['terminal_ui'] = lambda: False  # plain, byte-stable
        ns['render_route']('ok', 'supercomputer')
        ns['render_route']('down', 'personal')
        ns['render_route']('ok', 'personal')
        # Three independent per-turn labels, in order, none rewritten.
        self.assertEqual(out, ['· Supercomputer', '· Unavailable', '· This computer'])
        self.assertEqual(ns['LAST_ROUTE'], 'This computer')

    def test_send_once_labels_the_turn_it_ran(self):
        ns = load()
        out = []
        ns['say'] = out.append
        ns['terminal_ui'] = lambda: False
        ns['refresh_label'] = lambda k: ''
        # supercomputer ok -> Supercomputer
        ns['http'] = lambda m, u, body=None, headers=None, timeout=20: (
            (200, {'ok': True}) if u.endswith('/introspect') else
            (200, {'choices': [{'message': {'content': 'hi'}, 'finish_reason': 'stop'}]}))
        self.assertEqual(ns['send_once'](CLOUD, 'hello'), 0)
        self.assertIn('· Supercomputer', out)
        # a failed send -> Unavailable, nonzero
        out.clear()
        ns['http'] = lambda m, u, body=None, headers=None, timeout=20: (
            (200, {'ok': True}) if u.endswith('/introspect') else (503, {}))
        self.assertEqual(ns['send_once'](CLOUD, 'hello'), 1)
        self.assertIn('· Unavailable', out)


    def test_mixed_case_compute_reports_supercomputer_from_personal_mode(self):
        for prompt in ('/compute public task', '/COMPUTE public task', '/Compute public task'):
            with self.subTest(prompt=prompt):
                ns = load()
                out, calls = [], []
                ns['say'] = out.append
                ns['terminal_ui'] = lambda: False
                ns['chat_destination'] = lambda: ('personal', 'http://127.0.0.1:17735')
                def http(method, url, body=None, headers=None, timeout=20):
                    calls.append(url)
                    return 200, {'choices': [{'message': {'content': 'done'}, 'finish_reason': 'stop'}]}
                ns['http'] = http
                self.assertEqual(ns['send_once'](CLOUD, prompt), 0)
                self.assertEqual(calls, [ns['DOOR']])
                self.assertIn('· Supercomputer', out)
                self.assertNotIn('· This computer', out)


class Brand(unittest.TestCase):
    def test_truecolor_tier(self):
        ns = load()
        with patch.dict(ns['os'].environ, {'COLORTERM': 'truecolor'}):
            self.assertEqual(ns['brand_code'](), '38;2;56;173;250')

    def test_256_fallback_tier(self):
        ns = load()
        # No truecolor advertised -> accessible 256-color fallback.
        env = {k: v for k, v in ns['os'].environ.items() if k != 'COLORTERM'}
        with patch.dict(ns['os'].environ, env, clear=True):
            self.assertEqual(ns['brand_code'](), '38;5;75')

    def test_no_color_is_plain(self):
        ns = load({'NO_COLOR': '1', 'COLORTERM': 'truecolor'})
        ns['terminal_ui'] = lambda: True
        with patch.dict(ns['os'].environ, {'NO_COLOR': '1'}):
            self.assertEqual(ns['brand']('TARX'), 'TARX')

    def test_non_tty_is_plain(self):
        ns = load({'COLORTERM': 'truecolor'})
        ns['terminal_ui'] = lambda: False
        self.assertEqual(ns['brand']('TARX'), 'TARX')


class AlwaysOnRetired(unittest.TestCase):
    def test_identity_no_longer_claims_always_on(self):
        ns = load()
        out = []
        ns['say'] = out.append
        ns['refresh_label'] = lambda k: 'Ada'
        ns['say_who'](CLOUD)
        joined = '\n'.join(out)
        self.assertIn('I am TARX.', joined)
        self.assertNotIn('Always On', joined)

    def test_agents_command_no_always_on(self):
        ns = load()
        out = []
        ns['say'] = out.append
        ns['handle_command']('/agents')
        joined = '\n'.join(out)
        self.assertNotIn('Always On', joined)
        self.assertIn('TARX is the agent', joined)


class PrivacyBoundary(unittest.TestCase):
    def capture(self, ns, status=200, content='reply'):
        calls = []

        def http(method, url, body=None, headers=None, timeout=20):
            calls.append({'url': url, 'body': copy.deepcopy(body), 'headers': copy.deepcopy(headers)})
            if url.endswith('/introspect'):
                return 200, {'ok': True, 'label': 'Ada'}
            return status, {'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]}
        ns['http'] = http
        return calls

    def test_personal_turn_never_sends_history_or_cloud_key_to_the_door(self):
        # Configure a loopback personal runtime so chat_destination() == personal.
        ns = load({
            'TARX_PERSONAL_RUNTIME_URL': 'http://127.0.0.1:11435/v1',
            'TARX_PERSONAL_RUNTIME_MODEL': 'local-model',
            'TARX_PERSONAL_RUNTIME_KEY': 'LOCAL_ONLY_KEY',
        })
        self.assertEqual(ns['chat_destination']()[0], 'personal')
        calls = self.capture(ns)
        ns['reply_for'](CLOUD, 'first local thing')
        ns['reply_for'](CLOUD, 'second local thing')
        for c in calls:
            # Nothing personal is ever sent to the hosted door.
            self.assertNotEqual(c['url'], ns['DOOR'])
            self.assertNotIn('compute.tarx.com', c['url'])
            # The cloud credential is never used on the local path.
            auth = (c['headers'] or {}).get('Authorization', '')
            self.assertNotIn(CLOUD, auth)

    def test_compute_sends_only_the_task_no_history_no_private_markers(self):
        ns = load()  # default supercomputer
        calls = self.capture(ns)
        ns['reply_for'](CLOUD, 'remember cedar')          # seeds history
        ns['reply_for'](CLOUD, '/compute summarize the plan')
        compute_call = calls[-1]
        self.assertEqual(compute_call['url'], ns['DOOR'])
        msgs = compute_call['body']['messages']
        # Only the explicit task, never prior conversation history.
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]['content'], 'summarize the plan')
        self.assertNotIn('cedar', json.dumps(msgs))

    def test_compute_rejects_credential_or_private_path_markers(self):
        ns = load()
        calls = self.capture(ns)
        kind, text = ns['reply_for'](CLOUD, '/compute read /Users/someone/.ssh/id_rsa')
        self.assertEqual(kind, 'input')
        # Nothing was dispatched to the door for a private-path task.
        self.assertTrue(all(not c['url'].endswith('/chat/completions') or c['url'] != ns['DOOR'] for c in calls) or calls == [])


class ComposerGeometry(unittest.TestCase):
    """Real read_message over a PTY: two turns, exactly one dispatch per Enter,
    frame collapses to a single echo line, no stacking blank pages."""

    def _run_two_turns(self, env_extra=None):
        driver = ast.unparse(MODULE) + (
            '\n'
            'def reply_for(key, prompt): return "ok", "Hi there."\n'
            'def read_key(): return "tarx_cli_" + "a"*64\n'
            'def refresh_label(k): return ""\n'
            'def handle_command(t): return False\n'
            'def asks_identity(t): return False\n'
            'def introspect(k): return "ok"\n'
            'def chat_destination(): return "supercomputer", DOOR\n'
            'raise SystemExit(loop())\n'
        )
        master, slave = pty.openpty()
        td = tempfile.mkdtemp()
        script = Path(td) / 'drive.py'
        script.write_text(driver)
        env = dict(os.environ, TERM='xterm-256color', COLUMNS='80', LINES='24')
        env.update(env_extra or {})
        proc = subprocess.Popen([sys.executable, str(script)], stdin=slave, stdout=slave, stderr=slave, env=env)
        self.addCleanup(lambda: proc.kill() if proc.poll() is None else None)
        os.close(slave)

        def drain(seconds):
            out = b''
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        out += os.read(master, 65536)
                    except OSError:
                        break
                elif proc.poll() is not None:
                    break
            return out

        out = drain(2.0)
        self.assertIn(b'\x1b[?2004h', out, 'composer bracketed-paste frame must open')
        for msg in (b'hello', b'hello again'):
            os.write(master, msg)
            time.sleep(0.15)
            out += drain(0.6)
            self.assertIsNone(proc.poll(), 'typing must not submit')
            os.write(master, b'\r')
            time.sleep(0.25)
            out += drain(1.0)
        os.write(master, b'\x04')  # EOF ends the loop
        out += drain(1.5)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        os.close(master)
        return out

    def test_two_turns_one_dispatch_per_enter_and_frame_collapses(self):
        out = self._run_two_turns()
        text = out.decode('utf-8', 'replace')
        # Exactly one TARX reply per Enter (two turns -> two replies).
        self.assertEqual(text.count('Hi there.'), 2)
        # Each submitted message is echoed once as a compact "› message" line.
        self.assertEqual(text.count('› hello again'), 1)
        self.assertIn('› hello', text)
        # The editing box is collapsed, not left stacked: the second frame must
        # not be preceded by a growing run of blank lines. Assert no 3+ blank
        # lines in a row anywhere in the stream.
        self.assertNotIn('\r\n\r\n\r\n\r\n', text, 'blank space must not accumulate between turns')
        # Selected-route header is shown (pending) and is not a privacy claim.
        self.assertIn('pending', text)
        self.assertNotIn('PRIVATE', text)

    def test_redirected_output_has_no_frame_or_color(self):
        # Non-tty read_message path returns a plain readline with no ANSI.
        ns = load()
        ns['terminal_ui'] = lambda: False
        plain_sys = ns['sys']
        import io
        plain_sys.stdin = io.StringIO('plain line\n')
        self.assertEqual(ns['read_message'](), 'plain line\n')


if __name__ == '__main__':
    unittest.main()
