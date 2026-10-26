import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {installIdentity,runRuntimeEntry} from './tarx-runtime-entry.ts'
test('install identity is persistent and restrictive; missing saved CLI sign-in fails closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-entry-'))
 assert.equal(await installIdentity(dir),await installIdentity(dir));assert.equal((await stat(join(dir,'install-id'))).mode&0o777,0o600)
 const result=await runRuntimeEntry(['challenge','--state-dir',dir,'--credential-file',join(dir,'absent')])
 assert.deepEqual(result,{ok:false,error:'missing_credential'})
})
test('actual commands mint/approve challenge through server-derived principal then serve read-only claim',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-entry-')),key=join(dir,'cli-fixture')
 await writeFile(key,'tarx_cli_'+'f'.repeat(64),{mode:0o600})
 const ch:any=await runRuntimeEntry(['challenge','--state-dir',dir,'--credential-file',key],{fetcher:(async()=>new Response(JSON.stringify({ok:true,subject_id:'tvs_'+'a'.repeat(32)}))) as typeof fetch})
 assert.equal(ch.ok,true);assert.doesNotMatch(JSON.stringify(ch),/tarx_cli_/)
 assert.deepEqual(await runRuntimeEntry(['approve','--state-dir',dir,'--challenge',ch.challenge]),{ok:true})
 const running:any=await runRuntimeEntry(['serve','--state-dir',dir,'--worker-url','http://127.0.0.1:9999','--port','0'],{clientFactory:()=>({health:async()=>({ok:true,status:'ready'}),sessions:{attach:()=>({async *stream(){}})}})})
 try{
  const base='http://127.0.0.1:'+running.address.port
  const readiness=await(await fetch(base+'/readiness')).json();assert.equal(readiness.worker_reachable,true);assert.equal(readiness.healthy,false);assert.equal(readiness.model_responsive,false)
  const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin:'https://www.tarx.com','content-type':'application/json'},body:JSON.stringify({challenge:ch.challenge})})
  assert.equal(claim.status,200);assert.match((await claim.json()).pairing_credential,/^tpc_/)
 }finally{await running.listener.close()}
})
test('serve rejects external worker and missing runtime provenance',async()=>{
 await assert.rejects(()=>runRuntimeEntry(['serve','--worker-url','https://example.com']),/loopback_worker_required/)
 await assert.rejects(()=>runRuntimeEntry(['serve']),/existing_worker_required/)
})
test('entrypoint resolves the actual pinned Eve Client without starting a worker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-entry-client-'))
 const runtime:any=await runRuntimeEntry(['serve','--state-dir',dir,'--worker-url','http://127.0.0.1:9999','--eve-root',fileURLToPath(new URL('.',import.meta.url)),'--port','0'])
 try{assert.ok(runtime.address.port>0)}finally{await runtime.listener.close()}
})

test('failed saved sign-in exits nonzero through the actual command process',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-entry-exit-'))
 const {spawnSync}=await import('node:child_process')
 const result=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./tarx-runtime-entry.ts',import.meta.url)),'challenge','--state-dir',dir,'--credential-file',join(dir,'absent')],{encoding:'utf8'})
 assert.equal(result.status,1);assert.match(result.stdout,/missing_credential/)
})

test('installed symlink entry executes and fails closed without saved sign-in',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-entry-link-'))
 const {symlink}=await import('node:fs/promises'),{spawnSync}=await import('node:child_process')
 const link=join(dir,'entry.ts');await symlink(fileURLToPath(new URL('./tarx-runtime-entry.ts',import.meta.url)),link)
 const result=spawnSync(process.execPath,['--experimental-strip-types',link,'challenge','--state-dir',join(dir,'state'),'--credential-file',join(dir,'absent')],{encoding:'utf8'})
 assert.equal(result.status,1);assert.match(result.stdout,/missing_credential/)
})
