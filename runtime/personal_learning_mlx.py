#!/usr/bin/env python3
"""Bounded, offline-only local LoRA runner. JSON stdin; private logs stay local.

This runner never discovers user data or chooses an owner/model for the caller.
The trusted Node entrypoint supplies owner-bound paths and enforces consent.
It must execute inside the native no-network sandbox, not a shared model server.
"""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

os.umask(0o077)
for key,value in {'HF_HUB_OFFLINE':'1','HF_DATASETS_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1',
 'HF_HUB_DISABLE_TELEMETRY':'1','WANDB_MODE':'disabled','TOKENIZERS_PARALLELISM':'false'}.items():
 os.environ[key]=value

class Refused(Exception):
 pass

def private_file(path:Path,limit:int=262144)->bytes:
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_size>limit:
  raise Refused('unsafe_local_file')
 return path.read_bytes()

def inside(path:str,root:Path)->Path:
 p=Path(path)
 if not p.is_absolute() or '..' in p.parts:raise Refused('unsafe_local_path')
 resolved=p.resolve()
 if not resolved.is_relative_to(root) or resolved==root:raise Refused('unsafe_local_path')
 # Refuse symlinks on each existing component, even a symlink back inside.
 # macOS /var itself is an OS alias; stop at the canonical owner boundary.
 for c in [p,*p.parents]:
  if c.is_symlink():raise Refused('unsafe_local_path')
  if c.resolve()==root:break
 else:raise Refused('unsafe_local_path')
 return resolved

def digest_file(path:Path)->str:
 h=hashlib.sha256()
 with path.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()

def base_digest(base:Path)->str:
 files=sorted(base.glob('*.safetensors'))
 if not files:raise Refused('missing_local_weights')
 h=hashlib.sha256()
 for p in [base/'config.json',*files]:
  if not p.resolve().is_relative_to(base) or not p.is_file():raise Refused('unsafe_local_model')
  h.update(p.name.encode());h.update(digest_file(p).encode())
 return h.hexdigest()

def validate(request:dict)->tuple[Path,Path,Path,Path,int]:
 fields={'action','base_path','state_root','owner','job_id','examples_path','adapter_path','iterations'}
 if not isinstance(request,dict) or set(request)!=fields or request['action']!='train':raise Refused('invalid_request')
 if not isinstance(request['owner'],str) or not re.fullmatch('[a-f0-9]{64}',request['owner']):raise Refused('invalid_owner')
 if not isinstance(request['job_id'],str) or not re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',request['job_id']):raise Refused('invalid_job')
 iters=request['iterations']
 if type(iters) is not int or not 1<=iters<=128:raise Refused('invalid_budget')
 root=Path(request['state_root'])
 if not root.is_absolute() or root.is_symlink():raise Refused('unsafe_state_root')
 root=root.resolve();info=root.stat()
 if not root.is_dir() or info.st_uid!=os.getuid() or info.st_mode&0o077:raise Refused('unsafe_state_root')
 owner=root/request['owner'];owner.mkdir(mode=0o700,exist_ok=True)
 if owner.is_symlink() or owner.stat().st_mode&0o077:raise Refused('unsafe_owner_root')
 examples=inside(request['examples_path'],owner)
 adapter=inside(request['adapter_path'],owner)
 if adapter.name!=request['job_id'] or adapter.parent.name!='versions':raise Refused('unsafe_adapter_path')
 if adapter.exists():raise Refused('version_exists')
 base=Path(request['base_path'])
 if not base.is_absolute() or not base.is_dir():raise Refused('missing_local_model')
 base=base.resolve()
 cfg=json.loads((base/'config.json').read_text())
 if cfg.get('model_type') not in ('qwen3','qwen2'):raise Refused('unsupported_local_model')
 return base,owner,examples,adapter,iters

def train(request:dict)->dict:
 base,owner,examples,adapter,iters=validate(request)
 rows=[json.loads(x) for x in private_file(examples).decode().splitlines() if x.strip()]
 if not 1<=len(rows)<=64:raise Refused('invalid_examples')
 for row in rows:
  if not isinstance(row,dict) or set(row)!={'prompt','response'} or any(not isinstance(row[k],str) or not 1<=len(row[k])<=2000 for k in ('prompt','response')):
   raise Refused('invalid_examples')
 adapter.mkdir(parents=True,mode=0o700)
 log=adapter/'training.log'
 with log.open('x',encoding='utf8') as f,contextlib.redirect_stdout(f),contextlib.redirect_stderr(f):
  import mlx.core as mx
  from mlx_lm.utils import load
  from mlx_lm import generate
  from mlx_lm.lora import CONFIG_DEFAULTS,train_model
  mx.set_memory_limit(4*1024**3);mx.set_cache_limit(128*1024**2)
  before=base_digest(base)
  model,tokenizer=load(str(base),tokenizer_config={'trust_remote_code':False,'local_files_only':True})
  def answer(text:str)->str:
   prompt=tokenizer.apply_chat_template([{'role':'user','content':text}],tokenize=False,add_generation_prompt=True,enable_thinking=False)
   return generate(model,tokenizer,prompt=prompt,max_tokens=24,verbose=False).strip()
  def controls():
   math=answer('What is 2 + 2? Reply only with the number.')
   echo=answer('Repeat the word pear only.')
   return bool(re.fullmatch(r'4[.!]?',math)) and bool(re.fullmatch(r'pear[.!]?',echo,re.I))
  base_control=controls()
  class Examples:
   def __init__(self,data):self.data=data
   def __len__(self):return len(self.data)
   def __getitem__(self,i):return self.data[i]
   def process(self,row):
    prefix=tokenizer.apply_chat_template([{'role':'user','content':row['prompt']}],tokenize=True,add_generation_prompt=True,enable_thinking=False)
    tail=tokenizer.encode(row['response'],add_special_tokens=False)+[tokenizer.eos_token_id]
    if len(prefix)+len(tail)>256:raise Refused('example_too_long')
    return prefix+tail,len(prefix)
  # Candidate fit uses only explicitly approved pairs. No validation-loss claim:
  # generalization/personalization is evaluated separately in a cold process.
  args=dict(CONFIG_DEFAULTS)
  args.update(model=str(base),train=True,adapter_path=str(adapter),num_layers=4,batch_size=1,iters=iters,
   learning_rate=5e-5,steps_per_report=16,steps_per_eval=iters+1,save_every=iters,max_seq_length=256,
   val_batches=0,grad_checkpoint=True,lora_parameters={'rank':4,'dropout':0.0,'scale':8.0},report_to=None,
   data=str(examples),mask_prompt=True)
  # Fixed public retention examples are not captured conversation data. The
  # held-out checks use different wording/word, never these exact questions.
  anchors=[('What is two plus two?','4'),('What is 1 + 2?','3'),
   ('Compute 2 + 3.','5'),('What is 5 minus 1?','4'),
   ('Repeat only the word mint.','mint'),('Say only the word blue.','blue'),
   ('Give a short greeting.','Hello.'),('What is the opposite of hot?','cold'),
   ('How many days are in a week?','7'),('Name the planet we live on.','Earth'),
   ('Write just the number seven.','7'),('Repeat only the word lemon.','lemon'),
   ('Reply with just the word green.','green'),('How many legs does a cat have?','4'),
   ('Say only yes.','yes'),('Say only no.','no'),('Calculate 2+2.','4'),('Compute 3+3.','6')]
  retained=rows+[{'prompt':p,'response':r} for p,r in anchors]
  train_model(types.SimpleNamespace(**args),model,Examples(retained),Examples([]))
  candidate_control=controls()
  if base_digest(base)!=before:raise Refused('base_changed')
 artifact=adapter/'adapters.safetensors'
 if not artifact.is_file() or artifact.stat().st_size==0:raise Refused('missing_adapter')
 for p in adapter.rglob('*'):
  if p.is_file():p.chmod(0o600)
 result={'ok':True,'status':'trained','adapter_sha256':digest_file(artifact),'adapter_config_sha256':digest_file(adapter/'adapter_config.json'),'base_sha256':before,
  'base_control_passed':base_control,'candidate_control_passed':candidate_control}
 (adapter/'training-receipt.json').write_text(json.dumps(result,sort_keys=True)+'\n')
 return result

def main()->int:
 try:
  raw=sys.stdin.buffer.read(32769)
  if len(raw)>32768:raise Refused('request_too_large')
  result=train(json.loads(raw))
 except Refused as e:result={'ok':False,'status':'failed','error':str(e)}
 except Exception:result={'ok':False,'status':'failed','error':'local_training_failed'}
 print(json.dumps(result,separators=(',',':')))
 return 0 if result['ok'] else 1
if __name__=='__main__':raise SystemExit(main())
