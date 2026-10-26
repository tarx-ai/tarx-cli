import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
const origin='https://www.tarx.com', subject='tvs_'+'a'.repeat(32)
async function fixture(run:(base:string,challenge:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'tarx-pair-http-')),pairStore=createFilePairStore(join(dir,'pairs.json'))
 const challenge=await createPairingChallenge({loadCredential:async()=>'tarx_cli_'+'f'.repeat(64),install_id:'fixture_install',store:pairStore,fetcher:(async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))) as typeof fetch})
 assert.ok(challenge.ok);if(!challenge.ok)return
 await approvePairingChallenge(challenge.challenge,pairStore)
 const listener=createPairedSessionListener({host:'127.0.0.1',port:0,allowedOrigins:new Set([origin]),pairStore,ownerStore:createFileOwnerStore(join(dir,'owners.json')),eveClient:()=>({attach:()=>({async *stream(){}})}),readiness:async()=>({config_valid:true,worker_reachable:false,model_responsive:false,tools:[],healthy:false})})
 const {port}=await listener.listen()
 try{await run('http://127.0.0.1:'+port,challenge.challenge)}finally{await listener.close()}
}
const headers={origin,'content-type':'application/json'}
test('HTTP claim is scoped, no-store and one-use; no CLI credential returned',async()=>fixture(async(base,challenge)=>{
 const claim=()=>fetch(base+'/pairing/claim',{method:'POST',headers,body:JSON.stringify({challenge})})
 const r=await claim();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store')
 const body=await r.text();assert.match(JSON.parse(body).pairing_credential,/^tpc_[a-f0-9]{64}$/);assert.doesNotMatch(body,/tarx_cli_/)
 assert.equal((await claim()).status,403)
 assert.equal((await fetch(base+'/session/attach?session_id=wrun_'+ 'A'.repeat(26),{headers:{origin,authorization:'Bearer '+JSON.parse(body).pairing_credential}})).status,404)
}))
test('claim rejects foreign origin, spoofed identity, malformed and oversized input',async()=>fixture(async(base,challenge)=>{
 for(const [h,body,status] of [[{...headers,origin:'https://evil.example'},JSON.stringify({challenge}),403],[headers,JSON.stringify({challenge,subject_id:subject}),400],[headers,'{',400],[headers,JSON.stringify({challenge:'a'.repeat(3000)}),413]] as const){
  assert.equal((await fetch(base+'/pairing/claim',{method:'POST',headers:h,body})).status,status)
 }
 assert.equal((await fetch(base+'/pairing/approve',{method:'POST',headers,body:JSON.stringify({challenge})})).status,404)
}))
