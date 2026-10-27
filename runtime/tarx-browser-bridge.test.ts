import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {createHash} from 'node:crypto'
import {Script,createContext} from 'node:vm'
import {createBrowserBridge} from './tarx-browser-bridge.ts'
import {runRuntimeEntry} from './tarx-runtime-entry.ts'

const parent='https://www.tarx.com',challenge='ab'.repeat(32),bearer='tpc_'+'cd'.repeat(32)
function call(port:number,path:string,body?:unknown,headers:Record<string,string>={}):Promise<{status:number;headers:any;text:string}>{
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body)
  const r=request({hostname:'127.0.0.1',port,path,method:data?'POST':'GET',agent:false,headers:{...(data?{'content-type':'application/json','content-length':String(Buffer.byteLength(data))}:{}),...headers}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode??0,headers:res.headers,text}))
  });r.on('error',reject);r.end(data)
 })
}
async function fixture(){
 const seen:any[]=[]
 const core=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen.push({path:req.url,headers:req.headers,body:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/pairing/claim'?{ok:false,error:'not_approved'}:{role:'assistant',content:'Local fixture'}))})
 await new Promise<void>(r=>core.listen(0,'127.0.0.1',r));const address=core.address();assert.ok(address&&typeof address!=='string')
 const bridge=createBrowserBridge({port:0,corePort:address.port});const a=await bridge.listen()
 const page=await call(a.port,'/bridge?origin='+encodeURIComponent(parent));assert.equal(page.status,200)
 const nonce=page.text.match(/"nonce":"([a-f0-9]{64})"/)?.[1];assert.ok(nonce)
 return {bridge,seen,page,nonce,port:a.port,headers:{origin:'http://127.0.0.1:'+a.port,'x-tarx-local-bridge':nonce},
  async close(){await bridge.close();await new Promise<void>(r=>core.close(()=>r()))}}
}

test('actual serve-browser entrypoint exposes only a CSP-pinned local transport page',async()=>{
 const result=await runRuntimeEntry(['serve-browser','--port','0']);assert.ok('listener' in result&&result.listener)
 try{
  const page=await call(result.address.port,'/bridge');assert.equal(page.status,200)
  const source=page.text.match(/<script>([\s\S]*)<\/script>/)?.[1];assert.ok(source)
  new Script(source) // Node stripped all TypeScript before serialization into real browser JS.
  const hash=createHash('sha256').update(source).digest('base64')
  assert.match(page.headers['content-security-policy'],new RegExp(hash.replace(/[+/?]/g,'\\$&')))
  assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/)
  assert.equal(page.headers['cache-control'],'no-store')
  assert.equal((await call(result.address.port,'/bridge?origin=https://evil.example')).status,403)
 }finally{await result.listener.close()}
})

test('local browser relay strips RPC envelope; target is pinned and credentials stay in header',async()=>{
 const f=await fixture()
 try{
  assert.equal((await call(f.port,'/rpc',{id:'claim1',kind:'claim',challenge},f.headers)).status,200)
  const r=await call(f.port,'/rpc',{id:'personal1',kind:'personal',bearer,messages:[{role:'user',content:'synthetic local only'}]},f.headers)
  assert.equal(r.status,200);assert.equal(JSON.parse(r.text).content,'Local fixture')
  assert.equal(f.seen.length,2)
  assert.deepEqual(f.seen[0].body,{challenge})
  assert.deepEqual(f.seen[1].body,{messages:[{role:'user',content:'synthetic local only'}]})
  assert.equal(f.seen[1].headers.authorization,'Bearer '+bearer)
  assert.equal(f.seen[1].headers.origin,parent)
  assert.equal(JSON.stringify(f.seen[1].body).includes(bearer),false)
  for(const extra of [{url:'https://evil.example'},{model:'foreign'},{key:'foreign'},{history:['private']}])
   assert.equal((await call(f.port,'/rpc',{id:'bad',kind:'personal',bearer,messages:[{role:'user',content:'x'}],...extra},f.headers)).status,400)
  assert.equal((await call(f.port,'/rpc',{id:'compute',kind:'compute',task:'not supported'},f.headers)).status,400)
  assert.equal(f.seen.length,2)
 }finally{await f.close()}
})

test('learning RPC forwards to /personal-learning with strict request validation',async()=>{
 const f=await fixture()
 try{
  // valid learning request passes through; path is /personal-learning, bearer in header, body is the request
  const ok=await call(f.port,'/rpc',{id:'learn1',kind:'learning',bearer,request:{action:'status'}},f.headers)
  assert.equal(ok.status,200)
  assert.equal(f.seen.length,1)
  assert.equal(f.seen[0].path,'/personal-learning')
  assert.deepEqual(f.seen[0].body,{action:'status'})
  assert.equal(f.seen[0].headers.authorization,'Bearer '+bearer)
  assert.equal(f.seen[0].headers.origin,parent)
  // null, array, unknown action, and extra fields are rejected before reaching core
  for(const bad of [null,[],{action:'delete'},{action:'status',extra:1},{action:'add_example',example_id:'x'},{notaction:'status'}]){
   assert.equal((await call(f.port,'/rpc',{id:'bad',kind:'learning',bearer,request:bad},f.headers)).status,400,JSON.stringify(bad))
  }
  // a bad bearer shape is rejected
  assert.equal((await call(f.port,'/rpc',{id:'bad',kind:'learning',bearer:'nope',request:{action:'status'}},f.headers)).status,400)
  assert.equal(f.seen.length,1) // only the one valid request reached core
 }finally{await f.close()}
})

test('foreign origin, missing nonce, DNS-rebinding Host and oversized Unicode never reach paired listener',async()=>{
 const f=await fixture()
 try{
  const data={id:'claim1',kind:'claim',challenge}
  assert.equal((await call(f.port,'/rpc',data,{...f.headers,origin:'https://evil.example'})).status,403)
  assert.equal((await call(f.port,'/rpc',data,{origin:f.headers.origin})).status,403)
  assert.equal((await call(f.port,'/bridge',undefined,{host:'evil.example'})).status,403)
  assert.equal((await call(f.port,'/rpc',{id:'large',kind:'personal',bearer,messages:[{role:'assistant',content:'🌲'.repeat(4000)},{role:'user',content:'🌲'.repeat(5000)}]},f.headers)).status,400)
  assert.equal(f.seen.length,0)
 }finally{await f.close()}
})

test('actual browser script accepts only pinned opener/channel and uses same-origin RPC without secret URL',async()=>{
 const f=await fixture()
 try{
  const source=f.page.text.match(/<script>([\s\S]*)<\/script>/)?.[1];assert.ok(source)
  let listener:any;const announced:any[]=[],fetched:any[]=[]
  const owner={postMessage:(...x:any[])=>announced.push(x),focus(){}}
  const context=createContext({window:{opener:owner,addEventListener:(_name:string,fn:any)=>listener=fn},
   document:{getElementById:()=>({addEventListener(){}})},Map,AbortController,
   fetch:async(url:string,init:any)=>{fetched.push({url,init});return {status:200,text:async()=>JSON.stringify({ok:false,error:'not_approved'})}}})
  new Script(source).runInContext(context)
  assert.deepEqual(JSON.parse(JSON.stringify(announced)),[[{type:'tarx.local-bridge.ready',version:1},parent]])
  const replies:any[]=[];const port:any={onmessage:null,start(){},close(){},postMessage:(x:any)=>replies.push(x)}
  const data={type:'tarx.local-bridge.connect',version:1}
  listener({origin:'https://evil.example',source:owner,data,ports:[port]});assert.equal(port.onmessage,null)
  listener({origin:parent,source:{},data,ports:[port]});assert.equal(port.onmessage,null)
  listener({origin:parent,source:owner,data,ports:[port]});assert.equal(typeof port.onmessage,'function')
  await port.onmessage({data:{id:'request1',kind:'claim',challenge}})
  assert.equal(fetched[0].url,'/rpc')
  assert.equal(fetched[0].init.headers['x-tarx-local-bridge'],f.nonce)
  assert.equal(replies[0].id,'request1')
  assert.equal(f.page.text.includes(challenge),false)
 }finally{await f.close()}
})

test('Return selects the existing named parent with an empty URL, without closing its transport',async()=>{
 const f=await fixture()
 try{
  const name='tarx-return-'+'ef'.repeat(16)
  const page=await call(f.port,'/bridge?origin='+encodeURIComponent(parent)+'&return='+name)
  assert.equal(page.status,200)
  const source=page.text.match(/<script>([\s\S]*)<\/script>/)?.[1];assert.ok(source)
  let click:any;let focused=0;const opens:any[]=[]
  new Script(source).runInContext(createContext({window:{opener:{postMessage(){},focus(){throw Error('Safari ignores this path')}},
   addEventListener(){},open:(...args:any[])=>{opens.push(args);return {focus(){focused++}}}},
   document:{getElementById:()=>({addEventListener:(_event:string,fn:any)=>click=fn})},Map,AbortController}))
  click()
  assert.deepEqual(opens,[['',name]])
  assert.equal(focused,1)
  for(const bad of ['_blank','_top','https://evil.example','tarx-return-short'])
   assert.equal((await call(f.port,'/bridge?return='+encodeURIComponent(bad))).status,403)
  assert.equal(f.seen.length,0)
 }finally{await f.close()}
})
