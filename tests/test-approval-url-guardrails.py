"""Uncovered-edge regression for approval_url path/host/code guardrails.

The shipped tests/test-chat-auth.py checks the two-host canonical rewrite, an
evil host, and a bad code. It does NOT assert that a supplied verification_uri
on the correct host but a DIFFERENT path is refused, that the returned URL never
carries a supplied-but-mismatched code, or that the non-canonical AUTH branch
still rewrites to /agent?cli=. This locks those edges against regression.

Exercises the ACTUAL embedded approval_url from the shipped tarx script. No
model, network, email, approval, or host startup. Mock/fixture only.
"""
import ast
from pathlib import Path
import unittest

source = (Path(__file__).resolve().parent.parent / 'tarx').read_text().split("3<< 'PY'\n", 1)[1].split('\nPY\n', 1)[0]
tree = ast.parse(source)
module = ast.Module(body=[n for n in tree.body if not isinstance(n, ast.Try)], type_ignores=[])


class ApprovalUrlGuardrails(unittest.TestCase):
    def setUp(self):
        self.ns = {}
        exec(compile(module, '<tarx-chat>', 'exec'), self.ns)

    def approval_url(self, code, url, auth='https://tarx.com'):
        self.ns['AUTH'] = auth
        return self.ns['approval_url'](code, url)

    def test_correct_host_wrong_path_is_refused(self):
        # A verification_uri on the canonical host but NOT the device/agent path
        # must not produce an approval link.
        self.assertEqual(self.approval_url('AB12CD34', 'https://tarx.com/phish?cli=AB12CD34'), '')
        self.assertEqual(self.approval_url('AB12CD34', 'https://tarx.com/agentcli=AB12CD34'), '')
        self.assertEqual(self.approval_url('AB12CD34', 'https://tarx.com.evil.example/agent?cli=AB12CD34'), '')

    def test_accepted_device_and_agent_prefixes(self):
        # Both the legacy device path and the canonical agent path are accepted
        # inputs; the output is always the canonical www/agent link.
        self.assertEqual(self.approval_url('AB12CD34', 'https://tarx.com/auth/device?code=AB12CD34'), 'https://www.tarx.com/agent?cli=AB12CD34')
        self.assertEqual(self.approval_url('AB12CD34', 'https://tarx.com/agent?cli=AB12CD34'), 'https://www.tarx.com/agent?cli=AB12CD34')

    def test_output_uses_validated_code_not_the_supplied_query(self):
        # If the supplied URL carries a different code in its query, the output
        # must still use ONLY the validated 8-hex code argument.
        out = self.approval_url('AB12CD34', 'https://tarx.com/agent?cli=DEADBEEF&extra=1')
        self.assertEqual(out, 'https://www.tarx.com/agent?cli=AB12CD34')
        self.assertNotIn('DEADBEEF', out)
        self.assertNotIn('extra', out)

    def test_code_must_be_exactly_8_hex(self):
        for bad in ('AB12CD3', 'AB12CD345', 'GG12CD34', 'AB12CD3G', '', 'AB12 CD34'):
            self.assertEqual(self.approval_url(bad, 'https://tarx.com/agent?cli=' + bad), '', bad)

    def test_noncanonical_auth_still_rewrites_to_agent_cli(self):
        # A non-www AUTH (e.g. a staging host) keeps its origin but still emits
        # the /agent?cli= conversational entry, never a raw device path.
        out = self.approval_url('AB12CD34', 'https://staging.tarx.dev/auth/device?code=AB12CD34', auth='https://staging.tarx.dev')
        self.assertEqual(out, 'https://staging.tarx.dev/agent?cli=AB12CD34')

    def test_mismatched_auth_host_is_refused(self):
        # supplied_url host must match AUTH; a different host is refused even if
        # it is a tarx subdomain, because the prefix check is AUTH-anchored.
        self.assertEqual(self.approval_url('AB12CD34', 'https://other.tarx.com/agent?cli=AB12CD34', auth='https://tarx.com'), '')


if __name__ == '__main__':
    unittest.main()
