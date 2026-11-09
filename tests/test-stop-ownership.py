#!/usr/bin/env python3
"""Disposable service-process fixtures. Never probes or stops a host service."""
import os
import signal
import shutil
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class StopOwnership(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='tarx-stop-owner-')
        self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name)
        self.bin = self.home / 'fixture-bin'
        self.bin.mkdir()
        self.sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        self.addCleanup(self.close_sentinel)
        lsof = self.bin / 'lsof'
        lsof.write_text('#!/bin/sh\n[ "$2" = ":59991" ] && printf "%s\\n" "$FIXTURE_PID"\n')
        lsof.chmod(0o700)
        self.env = {**os.environ, 'HOME': str(self.home), 'PATH': str(self.bin) + ':/usr/bin:/bin:/usr/sbin:/sbin', 'FIXTURE_PID': str(self.sentinel.pid), 'TARX_INFERENCE_PORT': '59991', 'TARX_EMBED_PORT': '59992', 'TARX_MESH_PORT': '59993'}
        data = self.home / ('Library/Application Support/tarx' if sys.platform == 'darwin' else '.tarx')
        self.pids = data / 'pids'
        self.pids.mkdir(parents=True)

    def close_sentinel(self):
        if self.sentinel.poll() is None:
            self.sentinel.terminate()
        self.sentinel.wait(timeout=3)

    def stop(self):
        return subprocess.run(['sh', str(ROOT / 'tarx'), 'stop'], env=self.env, capture_output=True, text=True, timeout=8)

    def assert_preserved(self):
        self.stop()
        time.sleep(0.05)
        self.assertIsNone(self.sentinel.poll(), 'a port or PID alone must not authorize Stop')

    def test_port_only_process_is_never_adopted_or_stopped(self):
        self.assert_preserved()

    def test_legacy_pid_without_instance_proof_is_not_stopped(self):
        (self.pids / 'inference.pid').write_text(str(self.sentinel.pid))
        (self.pids / 'inference.pid').chmod(0o600)
        self.assert_preserved()

    def test_changed_instance_proof_is_not_stopped(self):
        (self.pids / 'inference.pid').write_text(str(self.sentinel.pid) + '\n' + '0' * 64 + '\n')
        (self.pids / 'inference.pid').chmod(0o600)
        self.assert_preserved()

    def test_invalid_or_linked_records_cannot_select_a_process_group(self):
        record = self.pids / 'inference.pid'
        for value in ['0', '1', '-1', '99999999999', 'not-a-pid']:
            record.write_text(value + '\n' + '0' * 64 + '\n')
            record.chmod(0o600)
            self.assert_preserved()
        record.unlink()
        target = self.home / 'outside-record'
        target.write_text(str(self.sentinel.pid))
        record.symlink_to(target)
        self.assert_preserved()
        self.assertEqual(target.read_text(), str(self.sentinel.pid))

    def test_successful_fixture_start_records_owned_instances(self):
        self.exercise_owned_start()

    def test_concurrent_starts_keep_one_owner_per_service(self):
        self.exercise_owned_start(concurrent=True)

    def test_reaped_stale_record_does_not_prevent_a_new_owner(self):
        exited = subprocess.Popen([sys.executable, '-c', 'pass'])
        exited.wait(timeout=3)
        record = self.pids / 'inference.pid'
        record.write_text(str(exited.pid) + '\n' + '0' * 64 + '\n')
        record.chmod(0o600)
        self.exercise_owned_start()

    def test_legacy_live_record_is_preserved_before_any_new_launch(self):
        models = self.pids.parent / 'models'
        models.mkdir()
        (models / 'tarx-qwen2.5-7b-deep-Q4_K_M.gguf').touch()
        record = self.pids / 'inference.pid'
        previous = str(self.sentinel.pid) + '\n'
        record.write_text(previous); record.chmod(0o600)
        curl = self.bin / 'curl'
        curl.write_text('#!/bin/sh\nexit 1\n'); curl.chmod(0o700)
        marker = self.home / 'must-not-launch'
        engine = self.bin / 'fixture-engine'
        engine.write_text('#!/bin/sh\ntouch "$FIXTURE_MARKER"\nexit 1\n'); engine.chmod(0o700)
        env = {**self.env, 'TARX_LLAMA_SERVER': str(engine), 'FIXTURE_MARKER': str(marker)}
        result = subprocess.run(['sh', str(ROOT / 'tarx'), 'start'], env=env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(record.read_text(), previous)
        self.assertIsNone(self.sentinel.poll())

    def exercise_owned_start(self, concurrent=False):
        if pathlib.Path('/usr/local/bin/tarx-mesh').exists() or shutil.which('tarx-mesh', path=self.env['PATH']):
            self.skipTest('a real mesh binary must never be started by this fixture')
        data = self.pids.parent
        models = data / 'models'
        models.mkdir()
        for name in ['tarx-qwen2.5-7b-deep-Q4_K_M.gguf', 'nomic-embed-text-v1.5-f16.gguf']:
            (models / name).touch()
        curl = self.bin / 'curl'
        curl.write_text('#!/bin/sh\nexit 1\n'); curl.chmod(0o700)
        trace = self.home / 'owned-fixture-pids'
        engine = self.bin / 'fixture-engine'
        engine.write_text('#!/bin/sh\nprintf "%s\\n" "$$" >> "$FIXTURE_ENGINE_PID_LOG"\nexec python3 -c "import time; time.sleep(30)"\n')
        engine.chmod(0o700)
        def alive(pid):
            result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
            return result.returncode == 0 and result.stdout.strip() and not result.stdout.strip().startswith('Z')
        owned = []
        try:
            env = {**self.env, 'TARX_LLAMA_SERVER': str(engine), 'TARX_START_PROBE_SECONDS': '0.05', 'FIXTURE_ENGINE_PID_LOG': str(trace)}
            if concurrent:
                launches = [subprocess.Popen(['sh', str(ROOT / 'tarx'), 'start'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
                results = [process.communicate(timeout=10) for process in launches]
                self.assertTrue(any(process.returncode == 0 for process in launches), results)
            else:
                result = subprocess.run(['sh', str(ROOT / 'tarx'), 'start'], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
            owned = [int(value) for value in trace.read_text().splitlines()]
            self.assertEqual(len(owned), 2)
            for service in ['inference', 'embeddings']:
                record = self.pids / (service + '.pid')
                rows = record.read_text().splitlines()
                self.assertEqual(len(rows), 2)
                self.assertIn(int(rows[0]), owned)
                self.assertRegex(rows[1], '^[a-f0-9]{64}$')
                self.assertEqual(record.stat().st_mode & 0o777, 0o600)
            records = {service: (self.pids / (service + '.pid')).read_bytes() for service in ['inference', 'embeddings']}
            again = subprocess.run(['sh', str(ROOT / 'tarx'), 'start'], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(again.returncode, 0, 'unhealthy existing owners must not be reported ready')
            self.assertEqual(len(trace.read_text().splitlines()), 2, 'repeated Start must not spawn duplicate warming services')
            for service, previous in records.items():
                self.assertEqual((self.pids / (service + '.pid')).read_bytes(), previous, 'Start must preserve the live ownership record')
            self.assertEqual(list(self.pids.glob('*.start-lock')), [], 'completed launchers must release their own reservations')
            stopped = self.stop()
            self.assertIn('Stop requested for owned inference', stopped.stdout)
            self.assertNotIn('Stopped inference', stopped.stdout)
            for _ in range(50):
                if not any(alive(pid) for pid in owned): break
                time.sleep(0.02)
            self.assertFalse(any(alive(pid) for pid in owned))
            self.assertIsNone(self.sentinel.poll())
        finally:
            if trace.exists():
                for pid in map(int, trace.read_text().splitlines()):
                    if alive(pid):
                        os.kill(pid, signal.SIGTERM)

if __name__ == '__main__':
    unittest.main()
