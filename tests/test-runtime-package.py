#!/usr/bin/env python3
"""Execute the real runtime installer in disposable storage; no network/services."""
import io,json,os,pathlib,subprocess,tarfile,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
SHA='a'*40
class RuntimePackage(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='tarx-package-');self.addCleanup(self.tmp.cleanup)
  self.base=pathlib.Path(self.tmp.name).resolve();self.bin=self.base/'bin';self.bin.mkdir();self.archive=self.base/'source.tar.gz'
  self.home=self.base/'runtime';self.home.mkdir();old=self.home/'old';old.mkdir();(old/'sentinel').write_text('existing');(self.home/'current').symlink_to(old)
  curl=self.bin/'curl';curl.write_text('''#!/usr/bin/env python3
import sys,os,json,shutil
args=sys.argv[1:];out=args[args.index('-o')+1];url=next(a for a in args if a.startswith('https://'))
if '/commits/main' in url:open(out,'w').write(json.dumps({'sha':'a'*40}))
elif os.environ.get('FAIL_FETCH'):sys.exit(22)
else:shutil.copyfile(os.environ['TEST_RUNTIME_ARCHIVE'],out)
''');curl.chmod(0o755)
  npm=self.bin/'npm';npm.write_text('#!/bin/sh\n[ "${FAIL_NPM:-0}" = 1 ] && exit 2\nprintf "%s\\n" "$*" > "$TEST_NPM_ARGS"\n');npm.chmod(0o755)
  for name in ['launchctl','systemctl','sudo']:
   p=self.bin/name;p.write_text('#!/bin/sh\nexit 99\n');p.chmod(0o755)
  self.env={**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],'TARX_RUNTIME_HOME':str(self.home),'TEST_RUNTIME_ARCHIVE':str(self.archive),'TEST_NPM_ARGS':str(self.base/'npm-args')}
  self.make_archive()
 def make_archive(self,attack=False):
  with tarfile.open(self.archive,'w:gz') as t:
   for p in (ROOT/'runtime').iterdir():
    if p.is_file():t.add(p,arcname=f'tarx-cli-{SHA}/runtime/{p.name}')
   if attack:
    m=tarfile.TarInfo(f'tarx-cli-{SHA}/runtime/escape');m.type=tarfile.SYMTYPE;m.linkname='/tmp/forbidden';t.addfile(m)
 def run_install(self,**extra):
  return subprocess.run(['sh',str(ROOT/'tarx'),'runtime','install'],env={**self.env,**extra},text=True,capture_output=True)
 def test_success_activates_complete_source_and_locked_dependencies(self):
  r=self.run_install();self.assertEqual(r.returncode,0,r.stderr)
  current=(self.home/'current').resolve();self.assertTrue((current/'tarx-runtime-entry.ts').is_file());self.assertTrue((self.home/'old'/'sentinel').exists())
  self.assertIn('--ignore-scripts',(self.base/'npm-args').read_text());self.assertIn('No service, worker or model was started',r.stdout)
 def test_failed_dependency_install_preserves_previous_runtime(self):
  r=self.run_install(FAIL_NPM='1');self.assertNotEqual(r.returncode,0);self.assertEqual((self.home/'current').resolve(),self.home/'old')
 def test_failed_download_preserves_previous_runtime(self):
  r=self.run_install(FAIL_FETCH='1');self.assertNotEqual(r.returncode,0);self.assertEqual((self.home/'current').resolve(),self.home/'old')
 def test_archive_symlink_is_rejected_before_activation(self):
  self.make_archive(attack=True);r=self.run_install();self.assertNotEqual(r.returncode,0);self.assertEqual((self.home/'current').resolve(),self.home/'old');self.assertFalse((self.base/'npm-args').exists())
if __name__=='__main__':unittest.main()
