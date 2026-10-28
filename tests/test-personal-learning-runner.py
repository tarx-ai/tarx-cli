#!/usr/bin/env python3
"""Pure validation tests; actual MLX/OS-sandbox proof is a separate local test."""
import importlib.util,json,os,pathlib,tempfile,unittest,uuid
spec=importlib.util.spec_from_file_location('learning',pathlib.Path(__file__).resolve().parents[1]/'runtime/personal_learning_mlx.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Guards(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.root.chmod(0o700)
  self.owner='ab'*32;self.home=self.root/self.owner;self.home.mkdir(mode=0o700)
  base=self.root/'base';base.mkdir();(base/'config.json').write_text(json.dumps({'model_type':'qwen3'}))
  examples=self.home/'examples.jsonl';examples.write_text('{"prompt":"x","response":"y"}\n');examples.chmod(0o600)
  job=str(uuid.uuid4());self.req={'action':'train','state_root':str(self.root),'owner':self.owner,'job_id':job,'base_path':str(base),'examples_path':str(examples),'adapter_path':str(self.home/'versions'/job),'iterations':64}
 def tearDown(self):self.temp.cleanup()
 def test_valid_owner_bound_request(self):self.assertEqual(m.validate(self.req)[-1],64)
 def test_budget_cannot_expand_or_use_bool(self):
  for n in (0,129,True,'64'):
   with self.assertRaises(m.Refused):m.validate(self.req|{'iterations':n})
 def test_no_network_model_identifier(self):
  for x in ('Qwen/Qwen3-0.6B','https://example.com/model'):
   with self.assertRaises(m.Refused):m.validate(self.req|{'base_path':x})
 def test_foreign_owner_and_parent_traversal_refused(self):
  for x in (self.root/'elsewhere',self.home/'..'/'elsewhere'):
   with self.assertRaises(m.Refused):m.validate(self.req|{'examples_path':str(x)})
 def test_symlink_even_inside_owner_refused(self):
  p=self.home/'alias';p.symlink_to(self.home/'examples.jsonl')
  with self.assertRaises(m.Refused):m.validate(self.req|{'examples_path':str(p)})
 def test_examples_are_owner_only_and_bounded(self):
  p=pathlib.Path(self.req['examples_path']);p.chmod(0o644)
  with self.assertRaises(m.Refused):m.private_file(p)
 def test_unexpected_field_and_owner_refused(self):
  for change in ({'url':'https://example.com'},{'owner':'../other'},{'action':'compute'}):
   with self.assertRaises(m.Refused):m.validate(self.req|change)
 def test_existing_adapter_version_immutable(self):
  p=pathlib.Path(self.req['adapter_path']);p.mkdir(parents=True)
  with self.assertRaises(m.Refused):m.validate(self.req)
if __name__=='__main__':unittest.main()
