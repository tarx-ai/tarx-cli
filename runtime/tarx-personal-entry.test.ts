import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {runRuntimeEntry} from './tarx-runtime-entry.ts'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge} from './tarx-browser-pairing.ts'
import {createLoopbackPersonalClient} from './tarx-personal-turn.ts'
import {loadPersonalClient} from './tarx-personal-config.ts'
const origin='https://www.tarx.com'

test('real serve-personal entry uses owner profile and native loopback transport; old read-only scope cannot infer',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tarx-personal-entry-')),state=join(home,'pairs'),dir=join(home,'.tarx','state');await mkdir(dir,{recursive:true})
 const seen:{body:any;authorization:unknown}[]=[]
 const model=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen.push({body:JSON.parse(raw),authorization:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Local fixture reply'}}]}))})
 await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));const address=model.address();assert.ok(address&&typeof address!=='string')
 const key=join(home,'existing.key');await writeFile(key,'LOCAL_FIXTURE_KEY',{mode:0o600})
 await writeFile(join(dir,'personal-runtime.json'),JSON.stringify({url:`http://127.0.0.1:${address.port}/v1`,model:'fixture-personal',key_file:key}),{mode:0o600})
 const runtime:any=await runRuntimeEntry(['serve-personal','--state-dir',state,'--port','0'],{personalHome:home,personalEnv:{}})
 const base=`http://127.0.0.1:${runtime.address.port}`,pairs=createFilePairStore(join(state,'pairs.json'))
 async function claim(scope?:string){
  const ch=await createPairingChallenge({loadCredential:async()=> 'tarx_cli_'+'f'.repeat(64),install_id:'fixture',store:pairs,fetcher:(async()=>new Response(JSON.stringify({ok:true,subject_id:'tvs_'+'a'.repeat(32)}))) as typeof fetch})
  assert.ok(ch.ok);if(!ch.ok)throw Error('fixture');assert.equal(await approvePairingChallenge(ch.challenge,pairs,Date.now(),scope),true)
  const r=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:ch.challenge})});assert.equal(r.status,200);return(await r.json() as any).pairing_credential
 }
 try{
  assert.equal(runtime.personal_configured,true)
  const old=await claim(),scoped=await claim('personal_chat'),body=JSON.stringify({messages:[{role:'user',content:'Synthetic private marker'}]})
  const headers=(token:string)=>({origin,'content-type':'application/json',authorization:'Bearer '+token})
  let r=await fetch(base+'/personal-turn',{method:'POST',headers:headers(old),body});assert.equal(r.status,403);assert.equal(seen.length,0)
  r=await fetch(base+'/personal-turn',{method:'POST',headers:headers(scoped),body});assert.equal(r.status,200);assert.deepEqual(await r.json(),{role:'assistant',content:'Local fixture reply'})
  assert.equal(seen.length,1);assert.equal(seen[0].authorization,'Bearer LOCAL_FIXTURE_KEY');assert.equal(seen[0].body.model,'fixture-personal');assert.equal(JSON.stringify(seen[0].body).includes('LOCAL_FIXTURE_KEY'),false)
  assert.deepEqual(seen[0].body.messages,[{role:'user',content:'Synthetic private marker'}])
 }finally{await runtime.listener.close();await new Promise<void>(r=>model.close(()=>r()));await rm(home,{recursive:true,force:true})}
})

test('native personal transport refuses redirects; invalid URLs never reach fetch',async()=>{
 let calls=0
 const sink=createServer((_q,r)=>{calls++;r.end('{}')});await new Promise<void>(r=>sink.listen(0,'127.0.0.1',r));const a=sink.address();assert.ok(a&&typeof a!=='string')
 const redirect=createServer((_q,r)=>{r.writeHead(307,{location:`http://127.0.0.1:${a.port}/stolen`});r.end()});await new Promise<void>(r=>redirect.listen(0,'127.0.0.1',r));const b=redirect.address();assert.ok(b&&typeof b!=='string')
 try{
  const client=createLoopbackPersonalClient({baseURL:`http://127.0.0.1:${b.port}`,model:'fixture',apiKey:'LOCAL_FIXTURE_KEY'})
  assert.equal(await client([{role:'user',content:'synthetic'}]),null);assert.equal(calls,0)
  for(const url of ['https://evil.example','http://user:pass@localhost:2','http://localhost:2/?key=x','http://localhost:2/#x','http://localhost:0','http://localhost:2/admin','ftp://localhost'])assert.throws(()=>createLoopbackPersonalClient({baseURL:url,model:'fixture'}))
 }finally{await new Promise<void>(r=>sink.close(()=>r()));await new Promise<void>(r=>redirect.close(()=>r()))}
})

test('unsafe or broken owner profile and outside-home credential fail closed',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tarx-personal-config-')),dir=join(home,'.tarx','state');await mkdir(dir,{recursive:true});const profile=join(dir,'personal-runtime.json')
 try{
  await writeFile(profile,JSON.stringify({url:'http://localhost:12',model:'fixture'}),{mode:0o644});assert.equal(await loadPersonalClient(home,{}),undefined)
  await chmod(profile,0o600);assert.ok(await loadPersonalClient(home,{}))
  await writeFile(profile,'{broken');assert.equal(await loadPersonalClient(home,{}),undefined)
  await writeFile(profile,JSON.stringify({url:'http://localhost:12',key_file:'/etc/hosts'}));assert.equal(await loadPersonalClient(home,{}),undefined)
 }finally{await rm(home,{recursive:true,force:true})}
})
