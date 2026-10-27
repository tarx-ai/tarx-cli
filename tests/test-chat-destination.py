"""Real embedded CLI functions and subprocess against loopback fixture servers.
No model, real identity, private file, install or external network is used.
"""
import ast
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

CLI = Path(__file__).resolve().parent.parent / 'tarx'
RAW = CLI.read_text().split("3<< 'PY'\n", 1)[1].split('\nPY\n', 1)[0]
TREE = ast.parse(RAW)
MODULE = ast.Module(body=[n for n in TREE.body if not isinstance(n, ast.Try)], type_ignores=[])
TEST_HOME = tempfile.TemporaryDirectory()
CLOUD = 'tarx_cli_' + 'a'*64
LOCAL = 'local-fixture-credential'
KEYS = ['TARX_PERSONAL_RUNTIME_URL', 'TARX_PERSONAL_RUNTIME_KEY', 'TARX_PERSONAL_RUNTIME_MODEL', 'TARX_CHAT_KEY', 'TARX_CHAT_TEXT']

def load(env=None):
    clean = {k:v for k,v in os.environ.items() if k not in KEYS}
    clean['HOME'] = TEST_HOME.name
    clean.update(env or {})
    with patch.dict(os.environ, clean, clear=True):
        ns = {}
        exec(compile(MODULE, '<actual-cli-chat>', 'exec'), ns)
        return ns

class Server:
    def __init__(self, status=200, redirect=None):
        self.calls=[]
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
                owner.calls.append({'path':self.path,'body':json.loads(raw),'headers':dict(self.headers)})
                self.send_response(status)
                if redirect: self.send_header('Location',redirect)
                self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(json.dumps({'choices':[{'message':{'content':'fixture reply'},'finish_reason':'stop'}]}).encode())
            def do_GET(self):
                owner.calls.append({'path':self.path,'headers':dict(self.headers)});self.send_response(500);self.end_headers()
            def log_message(self,*args): pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.url=f'http://127.0.0.1:{self.server.server_port}'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def close(self):
        self.server.shutdown();self.server.server_close();self.thread.join()

class EntrypointRouting(unittest.TestCase):
    def capture(self, ns, status=200):
        calls=[]
        def http(method,url,body=None,headers=None,timeout=20):
            calls.append({'method':method,'url':url,'body':copy.deepcopy(body),'headers':copy.deepcopy(headers)})
            if url.endswith('/introspect'): return 200,{'ok':True,'label':'Fixture'}
            return status,{'choices':[{'message':{'content':'reply'},'finish_reason':'stop'}]}
        ns['http']=http
        return calls

    def test_legacy_remote_route_is_explicit_and_preserved(self):
        ns=load();calls=self.capture(ns)
        self.assertEqual(ns['chat_destination'](),('supercomputer','https://compute.tarx.com/v1/chat/completions'))
        self.assertEqual(ns['reply_for'](CLOUD,'hello')[0],'ok')
        self.assertEqual(calls[-1]['url'],ns['DOOR'])
        self.assertEqual(calls[-1]['headers']['Authorization'],'Bearer '+CLOUD)
        self.assertIn('supercomputer',ns['capability_reply']())

    def test_local_model_and_credential_are_separate_without_auth_call(self):
        ns=load({'TARX_PERSONAL_RUNTIME_URL':'http://127.0.0.1:11463/v1','TARX_PERSONAL_RUNTIME_KEY':LOCAL,'TARX_PERSONAL_RUNTIME_MODEL':'personal-test'})
        calls=self.capture(ns)
        self.assertEqual(ns['reply_for'](CLOUD,'private marker')[0],'ok')
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['url'],'http://127.0.0.1:11463/v1/chat/completions')
        self.assertEqual(calls[0]['body']['model'],'personal-test')
        self.assertEqual(calls[0]['headers'],{'Authorization':'Bearer '+LOCAL})
        self.assertNotIn(CLOUD,json.dumps(calls))
        self.assertNotIn(LOCAL,json.dumps(calls[0]['body']))

    def test_no_cloud_bearer_when_local_key_not_configured(self):
        ns=load({'TARX_PERSONAL_RUNTIME_URL':'http://localhost:11463'})
        calls=self.capture(ns);ns['reply_for'](CLOUD,'hello')
        self.assertEqual(calls[0]['headers'],{})

    def test_malformed_or_remote_personal_urls_send_nothing(self):
        for url in ['https://evil.example/v1','http://user:pass@localhost:99','http://localhost:99/?token=x','http://localhost:99/#x','http://localhost:bad','http://localhost:0','http://localhost:99/admin','http://127.0.0.1.evil.example']:
            with self.subTest(url=url):
                ns=load({'TARX_PERSONAL_RUNTIME_URL':url});calls=self.capture(ns)
                self.assertEqual(ns['reply_for'](CLOUD,'private')[0],'down');self.assertEqual(calls,[])

    def test_personal_failure_never_falls_back_or_expires_cloud_identity(self):
        for status in [0,401,403,429,500,503,302,307]:
            with self.subTest(status=status):
                ns=load({'TARX_PERSONAL_RUNTIME_URL':'http://[::1]:11463/v1/chat/completions'});calls=self.capture(ns,status)
                kind,_=ns['reply_for'](CLOUD,'private')
                self.assertNotEqual(kind,'expired');self.assertNotEqual(kind,'ok')
                self.assertEqual(len(calls),1);self.assertIn('[::1]',calls[0]['url'])
                self.assertEqual(ns['HISTORY'],[])

    def test_explicit_compute_is_task_only_and_keeps_personal_history_local(self):
        ns=load({'TARX_PERSONAL_RUNTIME_URL':'http://127.0.0.1:11463','TARX_PERSONAL_RUNTIME_KEY':LOCAL})
        calls=self.capture(ns)
        ns['reply_for'](CLOUD,'PRIVATE_CONTEXT_ALPHA')
        history=copy.deepcopy(ns['HISTORY'])
        self.assertEqual(ns['reply_for'](CLOUD,'/COMPUTE summarize the public introduction')[0],'ok')
        self.assertEqual(calls[-1]['url'],ns['DOOR'])
        self.assertEqual(calls[-1]['body']['messages'],[{'role':'user','content':'summarize the public introduction'}])
        self.assertNotIn('PRIVATE_CONTEXT_ALPHA',json.dumps(calls[-1]))
        self.assertNotIn(LOCAL,json.dumps(calls[-1]));self.assertEqual(history,ns['HISTORY'][:len(history)])
        ns['reply_for'](CLOUD,'local followup')
        self.assertIn('PRIVATE_CONTEXT_ALPHA',json.dumps(calls[-1]['body']))
        self.assertIn('Supercomputer result: reply',json.dumps(calls[-1]['body']))
        self.assertIn('summarize the public introduction',json.dumps(calls[-1]['body']))
        ns['reply_for'](CLOUD,'/compute another public task')
        self.assertEqual(calls[-1]['body']['messages'],[{'role':'user','content':'another public task'}])

    def test_mode_switch_drops_prior_history_and_private_without_config_blocks(self):
        ns=load();calls=self.capture(ns)
        ns['say']=lambda *_:None
        ns['handle_command']('/private')
        self.assertEqual(ns['reply_for'](CLOUD,'private')[0],'down');self.assertEqual(calls,[])
        ns['PERSONAL_RUNTIME_URL']='http://localhost:11463'
        ns['reply_for'](CLOUD,'PRIVATE_MARKER')
        ns['handle_command']('/remote');ns['reply_for'](CLOUD,'public hello')
        self.assertNotIn('PRIVATE_MARKER',json.dumps(calls[-1]['body']))

    def test_compute_requires_explicit_task_and_key_and_refuses_secret_markers(self):
        ns=load();calls=self.capture(ns)
        for key,task in [('', '/compute public task'),(CLOUD,'/compute'),(CLOUD,'/compute '+CLOUD),(CLOUD,'/compute /Users/fixture/private')]:
            self.assertEqual(ns['compute_task'](key,task)[0],'input')
        self.assertEqual(calls,[])

    def test_actual_loop_dispatches_compute_as_control_not_a_personal_prompt(self):
        a,b=Server(),Server()
        self.addCleanup(a.close);self.addCleanup(b.close)
        ns=load({'TARX_PERSONAL_RUNTIME_URL':a.url,'TARX_PERSONAL_RUNTIME_KEY':LOCAL})
        ns['DOOR']=b.url+'/v1/chat/completions';ns['read_key']=lambda:CLOUD
        lines=iter(['PRIVATE_CONTEXT_ALPHA\n','/compute public task\n','local followup\n',''])
        ns['read_message']=lambda:next(lines);ns['say']=lambda *_:None
        ns['loop']()
        self.assertEqual(len(a.calls),2);self.assertEqual(len(b.calls),1)
        self.assertEqual(b.calls[0]['body']['messages'],[{'role':'user','content':'public task'}])
        self.assertNotIn('PRIVATE_CONTEXT_ALPHA',json.dumps(b.calls));self.assertNotIn(LOCAL,json.dumps(b.calls))
        self.assertNotIn(CLOUD,json.dumps(a.calls));self.assertEqual(b.calls[0]['headers']['Authorization'],'Bearer '+CLOUD)

    def test_actual_transport_refuses_redirect_with_private_prompt_or_bearer(self):
        sink=Server();self.addCleanup(sink.close)
        a=Server(status=302,redirect=sink.url+'/capture');self.addCleanup(a.close)
        ns=load({'TARX_PERSONAL_RUNTIME_URL':a.url,'TARX_PERSONAL_RUNTIME_KEY':LOCAL})
        self.assertEqual(ns['reply_for'](CLOUD,'PRIVATE_MARKER')[0],'down')
        self.assertEqual(len(a.calls),1);self.assertEqual(sink.calls,[])

    def test_full_cli_personal_subprocess_uses_no_cloud_signin(self):
        a=Server();self.addCleanup(a.close)
        with tempfile.TemporaryDirectory() as home:
            env={k:v for k,v in os.environ.items() if k not in KEYS}
            env.update({'HOME':home,'TARX_PERSONAL_RUNTIME_URL':a.url,'TARX_PERSONAL_RUNTIME_KEY':LOCAL,'TARX_PERSONAL_RUNTIME_MODEL':'local-test','TARX_CHAT_KEY':CLOUD})
            env.update({'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','NO_PROXY':'127.0.0.1,localhost,::1','TARX_AUTH_ORIGIN':a.url})
            p=subprocess.run(['sh',str(CLI),'chat','PRIVATE_FIXTURE'],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,0,p.stderr+p.stdout);self.assertIn('fixture reply',p.stdout)
        self.assertEqual(len(a.calls),1);self.assertEqual(a.calls[0]['body']['model'],'local-test')
        self.assertNotIn(CLOUD,json.dumps(a.calls));self.assertNotIn(LOCAL,p.stdout+p.stderr)

    def test_full_interactive_cli_preserves_stdin_and_private_route(self):
        a=Server();self.addCleanup(a.close)
        with tempfile.TemporaryDirectory() as home:
            env={k:v for k,v in os.environ.items() if k not in KEYS}
            env.update({'HOME':home,'TARX_PERSONAL_RUNTIME_URL':a.url,'TARX_PERSONAL_RUNTIME_KEY':LOCAL})
            env.update({'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','NO_PROXY':'127.0.0.1,localhost,::1','TARX_AUTH_ORIGIN':a.url})
            p=subprocess.run(['sh',str(CLI)],input='PRIVATE_FIXTURE\nquit\n',env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,0,p.stderr+p.stdout)
        self.assertIn('Private mode selected',p.stdout);self.assertIn('fixture reply',p.stdout)
        self.assertEqual(len(a.calls),1);self.assertNotIn(CLOUD,json.dumps(a.calls))

    def test_failed_personal_turn_stays_in_loop_and_manual_retry_stays_local(self):
        ns=load({'TARX_PERSONAL_RUNTIME_URL':'http://127.0.0.1:11463'})
        calls=[]
        def http(method,url,body=None,**kw):
            calls.append(url)
            return (503,{}) if len(calls)==1 else (200,{'choices':[{'message':{'content':'retry reply'}}]})
        ns['http']=http;ns['read_key']=lambda:'';ns['say']=lambda *_:None
        lines=iter(['private first\n','manual retry\n',''])
        ns['read_message']=lambda:next(lines);self.assertEqual(ns['loop'](),0)
        self.assertEqual(calls,['http://127.0.0.1:11463/v1/chat/completions']*2)

    def test_persistent_private_profile_drives_actual_cli_without_cloud_key(self):
        a=Server();self.addCleanup(a.close)
        with tempfile.TemporaryDirectory() as home:
            state=Path(home)/'.tarx/state';state.mkdir(parents=True)
            secret=state/'local.key';secret.write_text(LOCAL);secret.chmod(0o600)
            profile=state/'personal-runtime.json'
            profile.write_text(json.dumps({'url':a.url,'model':'profile-model','key_file':str(secret)}));profile.chmod(0o600)
            env={k:v for k,v in os.environ.items() if k not in KEYS};env['HOME']=home
            env.update({'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','NO_PROXY':'127.0.0.1,localhost,::1','TARX_AUTH_ORIGIN':a.url})
            p=subprocess.run(['sh',str(CLI),'chat','PRIVATE_PROFILE_FIXTURE'],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,0,p.stderr+p.stdout);self.assertIn('fixture reply',p.stdout)
        self.assertEqual(len(a.calls),1);self.assertEqual(a.calls[0]['headers']['Authorization'],'Bearer '+LOCAL)
        self.assertEqual(a.calls[0]['body']['model'],'profile-model')
        self.assertNotIn(LOCAL,json.dumps(a.calls[0]['body']));self.assertNotIn('key_file',json.dumps(a.calls[0]['body']))

    def test_broken_or_shared_readable_private_profile_never_becomes_remote(self):
        for text,mode in [('bad-json',0o600),('{"url":"http://localhost:9"}',0o644)]:
            with tempfile.TemporaryDirectory() as home:
                state=Path(home)/'.tarx/state';state.mkdir(parents=True)
                p=state/'personal-runtime.json';p.write_text(text);p.chmod(mode)
                ns=load({'HOME':home});calls=self.capture(ns)
                self.assertEqual(ns['chat_destination']()[0],'personal_misconfigured')
                self.assertEqual(ns['reply_for'](CLOUD,'PRIVATE')[0],'down');self.assertEqual(calls,[])

if __name__=='__main__':unittest.main()
