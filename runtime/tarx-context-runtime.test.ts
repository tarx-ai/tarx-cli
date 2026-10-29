import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createLoopbackPersonalClient} from './tarx-personal-turn.ts'
import {createPersonalContextResolver,type PersonalContextResolver} from './tarx-context-runtime.ts'
import {createContextCache,type ContextScope,type PackResult} from './tarx-context-cache.ts'
import {ownerNamespace} from './tarx-local-learning.ts'
const origin='https://www.tarx.com'
const scope=(owner:string):ContextScope=>({owner_namespace:owner,workspace_id:'work',channel_id:'personal',purpose:'continue',grant_revision:'rev1'})
const request=(owner:string)=>({schema_version:1,scope:scope(owner),recipient:{location:'this_computer',provider_id:'owned-local',model_id:'fixture'},policy_version:'v1',prompt_version:'v1',fact_ids:['goal'],max_bytes:2048})
const fact=(owner:string)=>({schema_version:1,fact_id:'goal',scope:scope(owner),kind:'goal',revision:1,source_version:'v1',classification:'private_local',body:'OWNED_CONTEXT_CANARY',expires_at:'2099-01-01T00:00:00Z',deleted_at:null})
async function fixture(resolver?:PersonalContextResolver,withContext=true){
 const dir=await mkdtemp(join(tmpdir(),'tarx-context-http-')),pairs=createFilePairStore(join(dir,'pairs.json')),captured:any[]=[]
 const challenge=await createPairingChallenge({loadCredential:async()=> 'tarx_cli_'+'a'.repeat(64),install_id:'fixture_install',store:pairs,fetcher:(async()=>new Response(JSON.stringify({ok:true,subject_id:'tvs_'+'a'.repeat(32)}))) as typeof fetch})
 assert.ok(challenge.ok);if(!challenge.ok)throw Error('fixture')
 assert.equal(await approvePairingChallenge(challenge.challenge,pairs,Date.now(),withContext?['personal_chat','personal_context']:['personal_chat']),true)
 const client=createLoopbackPersonalClient({baseURL:'http://127.0.0.1:11463',model:'fixture-model',fetcher:(async(_url:any,init:any)=>{captured.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:'reply\u0000'}}]}))}) as typeof fetch})
 const server=createPairedSessionListener({host:'127.0.0.1',port:0,allowedOrigins:new Set([origin]),pairStore:pairs,ownerStore:createFileOwnerStore(join(dir,'owners.json')),personalClient:client,personalContext:resolver,eveClient:()=>({attach:()=>({async *stream(){}})}),readiness:async()=>({config_valid:true,worker_reachable:false,model_responsive:false,tools:[],healthy:false})})
 const address=await server.listen(),base='http://127.0.0.1:'+address.port
 const claimed=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:challenge.challenge})})
 const credential=(await claimed.json()).pairing_credential
 const send=(body:any)=>fetch(base+'/personal-turn',{method:'POST',headers:{origin,'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify(body)})
 return {dir,captured,send,revoke:()=>revokePairing(createHash('sha256').update(challenge.challenge).digest('hex'),pairs),close:async()=>{await server.close();await rm(dir,{recursive:true,force:true})}}
}
test('owned context reaches actual HTTP personal consumer; principal is server-derived',async()=>{
 let fx:Awaited<ReturnType<typeof fixture>>,seen=''
 fx=await fixture(async(owner,model)=>{seen=owner;assert.equal(model,'fixture-model');const cache=createContextCache({file:join(fx.dir,'context.json'),key:Buffer.alloc(32,7)});await cache.putFact(owner,fact(owner));return cache.pack(owner,request(owner))})
 try{const res=await fx.send({messages:[{role:'user',content:'hello'}]});assert.equal(res.status,200);assert.equal((await res.json()).content,'reply');assert.equal(seen,ownerNamespace('tvs_'+'a'.repeat(32),'fixture_install'));assert.ok(JSON.stringify(fx.captured).includes('OWNED_CONTEXT_CANARY'));assert.equal(fx.captured[0].model,'fixture-model')}finally{await fx.close()}
})
test('chat-only approval skips context; browser cannot supply identity/context fields',async()=>{
 let calls=0;const fx=await fixture(async()=>{calls++;throw Error('must not read')},false)
 try{assert.equal((await fx.send({messages:[{role:'user',content:'hello'}]})).status,200);assert.equal(calls,0);assert.equal((await fx.send({messages:[{role:'user',content:'hello'}],owner_namespace:'spoof',context:'bad'})).status,400);assert.equal(fx.captured.length,1)}finally{await fx.close()}
})
test('resolver failure and revoked grant refuse model dispatch',async()=>{
 const fx=await fixture(async()=>{throw Error('SECRET operator path')})
 try{const res=await fx.send({messages:[{role:'user',content:'hello'}]});assert.equal(res.status,503);assert.equal((await res.text()).includes('SECRET'),false);assert.equal(fx.captured.length,0);await fx.revoke();assert.equal((await fx.send({messages:[{role:'user',content:'hello'}]})).status,401)}finally{await fx.close()}
})
test('revocation during context resolution is checked before model dispatch',async()=>{
 let fx:Awaited<ReturnType<typeof fixture>>;fx=await fixture(async()=>{await fx.revoke();return null})
 try{assert.equal((await fx.send({messages:[{role:'user',content:'hello'}]})).status,401);assert.equal(fx.captured.length,0)}finally{await fx.close()}
})
test('operator loader is optional, owner-bound, reloads disable and rejects unsafe config',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tarx-context-policy-')),state=join(home,'.tarx','state'),root=join(state,'context'),owner='a'.repeat(64)
 try{
  await mkdir(root,{recursive:true,mode:0o700});await chmod(state,0o700)
  const resolve=createPersonalContextResolver(home);assert.equal(await resolve(owner,'model-a'),null)
  await writeFile(join(root,'operator.key'),'07'.repeat(32),{mode:0o600})
  const cache=createContextCache({file:join(root,'facts.json'),key:Buffer.alloc(32,7)});await cache.putFact(owner,fact(owner))
  const policy={version:1,key_name:'operator',cache_name:'facts',bindings:[{scope:scope(owner),enabled:true,fact_ids:['goal'],policy_version:'v1',prompt_version:'v1',max_bytes:2048}]}
  const path=join(state,'context-runtime.json');await writeFile(path,JSON.stringify(policy),{mode:0o600})
  const first=await resolve(owner,'model-a'),otherModel=await resolve(owner,'model-b');assert.ok(first?.ok&&otherModel?.ok)
  if(first?.ok&&otherModel?.ok){assert.notEqual(first.cache_key,otherModel.cache_key);assert.equal(first.packet.facts[0].body,'OWNED_CONTEXT_CANARY')}
  await assert.rejects(resolve('b'.repeat(64),'model-a'))
  policy.bindings[0].enabled=false;await writeFile(path,JSON.stringify(policy));await assert.rejects(resolve(owner,'model-a'))
  await chmod(path,0o644);await assert.rejects(resolve(owner,'model-a'))
 }finally{await rm(home,{recursive:true,force:true})}
})
