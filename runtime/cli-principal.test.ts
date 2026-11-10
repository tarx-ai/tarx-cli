import assert from 'node:assert/strict'
import test from 'node:test'
import {resolveCliPrincipal} from './cli-principal.ts'
const token='tarx_cli_'+'a'.repeat(64),subject='tvs_'+'b'.repeat(32)
test('local CLI resolves the stored principal through the exact authority without spend or credential disclosure',async()=>{
 const result=await resolveCliPrincipal({loadCredential:async()=>token,fetcher:(async(url:any,init:any)=>{assert.equal(url,'https://tarx.com/api/auth/cli/introspect');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{token,spend:false});return Response.json({ok:true,subject_id:subject})}) as typeof fetch})
 assert.deepEqual(result,{ok:true,subject_id:subject});assert.doesNotMatch(JSON.stringify(result),/tarx_cli_/)
})
test('missing local credential never makes an identity call',async()=>{
 const result=await resolveCliPrincipal({loadCredential:async()=>'',fetcher:(async()=>{throw Error('must not call')})as typeof fetch});assert.deepEqual(result,{ok:false,error:'missing_credential'})
})
test('legacy/missing/foreign credential responses cannot seed a stable session owner',async()=>{
 for(const body of [{ok:true},{ok:true,subject_id:'tjs_'+'a'.repeat(32)},{ok:false,subject_id:subject}])assert.equal((await resolveCliPrincipal({loadCredential:async()=>token,fetcher:(async()=>Response.json(body))as typeof fetch})).ok,false)
 assert.equal((await resolveCliPrincipal({loadCredential:async()=>token,fetcher:(async()=>Response.json({subject_id:subject},{status:401}))as typeof fetch})).ok,false)
})
test('authority failure returns bounded error without echoing credentials or response data',async()=>{
 const result=await resolveCliPrincipal({loadCredential:async()=>token,fetcher:(async()=>{throw Error(token)})as typeof fetch});assert.deepEqual(result,{ok:false,error:'identity_unavailable'})
})

test('caller cancellation reaches the identity read without sending extra context',async()=>{
 const abort=new AbortController();let calls=0
 const result=resolveCliPrincipal({loadCredential:async()=> 'tarx_cli_'+'1'.repeat(64),signal:abort.signal,fetcher:(async(_url,options)=>{calls++;return new Promise<Response>((_resolve,reject)=>{const signal=options?.signal;signal?.addEventListener('abort',()=>reject(Error('cancelled identity fixture')),{once:true});abort.abort()})}) as typeof fetch})
 assert.deepEqual(await result,{ok:false,error:'identity_unavailable'});assert.equal(calls,1)
 let read=false
 assert.deepEqual(await resolveCliPrincipal({signal:abort.signal,loadCredential:async()=>{read=true;return 'unread'}}),{ok:false,error:'identity_unavailable'});assert.equal(read,false)
})
