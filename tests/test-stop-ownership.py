#!/usr/bin/env python3
"""Disposable service-process fixtures. Never probes or stops a host service."""
import os
import fcntl
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

    def test_foreground_interrupt_does_not_kill_owned_services(self):
        self.exercise_owned_start(interrupt=True)

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

    def test_killed_launcher_releases_kernel_reservation(self):
        lock = self.pids / 'inference.pid.start-lock'
        code = 'import os,fcntl,time,sys; fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600); fcntl.flock(fd,fcntl.LOCK_EX); print("held",flush=True); time.sleep(30)'
        locker = subprocess.Popen([sys.executable, '-c', code, str(lock)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(locker.stdout.readline().strip(), 'held')
            locker.kill(); locker.wait(timeout=3)
            self.exercise_owned_start()
        finally:
            if locker.poll() is None: locker.kill()
            locker.wait(timeout=3); locker.stdout.close()

    def test_terminated_startup_reaps_unpublished_child(self):
        for signum in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            for boundary in [None, 'spawn', 'publish', 'repeat']:
                with self.subTest(signal=signum, boundary=boundary):
                    self.exercise_unpublished_termination(signum, boundary)

    def exercise_unpublished_termination(self, signum, boundary):
        # Actual inline helper; the boundary shim delivers the signal after
        # creation but before Popen can return its handle to the caller.
        source = (ROOT / 'tarx').read_text().split("<<'OWNER_PY'\n", 1)[1].split('\nOWNER_PY', 1)[0]
        trace = self.home / ('unpublished-child-' + str(signum) + str(boundary))
        engine = self.bin / 'fixture-starting-engine'
        engine.write_text('#!' + sys.executable + '\nimport os,time,pathlib\nif os.environ.get("FIXTURE_START_WRAPPED") != "1": pathlib.Path(os.environ["FIXTURE_START_TRACE"]).write_text(str(os.getpid()))\ntime.sleep(30)\n')
        engine.chmod(0o700)
        if boundary:
            source = ('import os,pathlib,signal,subprocess\n_real_spawn = subprocess.Popen\n'
                'def fixture_spawn(*args, **kwargs):\n'
                '    child = _real_spawn(*args, **kwargs)\n'
                '    if kwargs.get("start_new_session"):\n'
                '        pathlib.Path(os.environ["FIXTURE_START_TRACE"]).write_text(str(child.pid))\n'
                + ('        os.kill(os.getpid(), ' + str(int(signum)) + ')\n' if boundary == 'spawn' else '')
                + '    return child\nsubprocess.Popen = fixture_spawn\n' + (
                    '_real_link = os.link\ndef fixture_link(*args, **kwargs):\n    _real_link(*args, **kwargs)\n    os.kill(os.getpid(), ' + str(int(signum)) + ')\nos.link = fixture_link\n' if boundary == 'publish' else '') + (
                    '_real_signal = signal.signal\ndef fixture_signal(number, handler):\n    if handler == signal.SIG_IGN: os.kill(os.getpid(), ' + str(int(signum)) + ')\n    return _real_signal(number, handler)\nsignal.signal = fixture_signal\n' if boundary == 'repeat' else '') + source)
        record = self.pids / 'inference.pid'
        launcher = subprocess.Popen([sys.executable, '-c', source, 'start', str(record), str(self.home / 'fixture.log'), '0' if boundary == 'publish' else '30', str(engine)],
            env={**self.env, 'FIXTURE_START_TRACE': str(trace), 'FIXTURE_START_WRAPPED': '1' if boundary else '0'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child = None
        def alive(value):
            result = subprocess.run(['/bin/ps', '-p', str(value), '-o', 'stat='], capture_output=True, text=True)
            return result.returncode == 0 and result.stdout.strip() and not result.stdout.strip().startswith('Z')
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if trace.exists() and trace.read_text().strip().isdigit(): break
                if launcher.poll() is not None: self.fail('fixture launcher exited before recording its disposable child')
                time.sleep(0.01)
            self.assertTrue(trace.exists(), 'fixture must enter the spawn/publication interval')
            child = int(trace.read_text())
            if boundary != 'publish': self.assertFalse(record.exists())
            if boundary in (None, 'repeat'):
                self.assertTrue(alive(child)); launcher.send_signal(signum)
            _out, _err = launcher.communicate(timeout=4)
            self.assertNotEqual(launcher.returncode, 0)
            if boundary == 'publish':
                self.assertEqual(launcher.returncode, 3, 'published owner must report starting, not a launch failure')
                self.assertTrue(alive(child), 'published service must survive launcher cancellation')
                self.assertEqual(int(record.read_text().splitlines()[0]), child)
                record.unlink()  # Fixture record only; child remains owned by test cleanup.
            else:
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline and alive(child): time.sleep(0.01)
                self.assertFalse(alive(child), 'termination before ownership publication must not orphan the engine: ' + _err)
                self.assertFalse(record.exists())
            self.assertIsNone(self.sentinel.poll(), 'unrelated sentinel must survive startup cleanup')
            with pathlib.Path(str(record) + '.start-lock').open('r+') as lease:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            if launcher.poll() is None: launcher.kill()
            launcher.communicate(timeout=3)
            if child is None and trace.exists() and trace.read_text().strip().isdigit(): child = int(trace.read_text())
            if child is not None and alive(child): os.kill(child, signal.SIGKILL)

    def exercise_owned_start(self, concurrent=False, interrupt=False):
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
        engine.write_text('#!' + sys.executable + '\nimport os,time\nwith open(os.environ["FIXTURE_ENGINE_PID_LOG"], "a") as trace: trace.write(str(os.getpid()) + "\\n")\ntime.sleep(30)\n')
        engine.chmod(0o700)
        def alive(pid):
            result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
            return result.returncode == 0 and result.stdout.strip() and not result.stdout.strip().startswith('Z')
        owned = []
        try:
            env = {**self.env, 'TARX_LLAMA_SERVER': str(engine), 'TARX_START_PROBE_SECONDS': '0.2', 'FIXTURE_ENGINE_PID_LOG': str(trace)}
            if interrupt:
                launcher = subprocess.Popen(['sh', str(ROOT / 'tarx'), 'start'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
                try:
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        if all((self.pids / (service + '.pid')).exists() for service in ['inference', 'embeddings']): break
                        if launcher.poll() is not None: self.fail('launcher exited before publishing both service owners')
                        time.sleep(0.01)
                    self.assertTrue((self.pids / 'embeddings.pid').exists())
                    for value in trace.read_text().splitlines():
                        self.assertNotEqual(os.getpgid(int(value)), launcher.pid)
                    os.killpg(launcher.pid, signal.SIGINT)
                    launcher.communicate(timeout=5)
                    self.assertTrue(all(alive(int(value)) for value in trace.read_text().splitlines()), 'foreground Ctrl-C must leave owned services alive')
                finally:
                    if launcher.poll() is None: os.killpg(launcher.pid, signal.SIGKILL)
                    launcher.communicate(timeout=3)
            elif concurrent:
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
            for lock in self.pids.glob('*.start-lock'):
                self.assertTrue(lock.is_file())
                self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
                with lock.open('r+') as lease:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            stopped = self.stop()
            self.assertIn('Stop requested for owned inference', stopped.stdout, stopped.stderr)
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
