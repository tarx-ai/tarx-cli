import assert from 'node:assert/strict'
import test from 'node:test'
import https from 'node:https'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {createSupercomputerPlannerClient} from './tarx-supercomputer-planner.ts'
const token='tarx_cli_'+'1'.repeat(64),schema={type:'object',properties:{status:{const:'blocked'}}}
const messages=[{role:'user',content:'Explicit fixture task only'}]
const opts={jsonSchema:schema}
type Behavior=(req:any,callback:any,body:string|undefined,options:any,url:string)=>void
function transport(t:any,behavior:Behavior){
 const calls:any[]=[]
 t.mock.method(https,'request',(url:string,options:any,callback:any)=>{
  const req:any=new EventEmitter();req.destroyed=false
  req.destroy=()=>{if(!req.destroyed){req.destroyed=true;req.emit('close')}return req}
  req.end=(body:string|undefined)=>{calls.push({url,options,body});queueMicrotask(()=>behavior(req,callback,body,options,url))}
  return req
 });return calls
}
function reply(callback:any,value:unknown,status=200){const res:any=new PassThrough();res.statusCode=status;callback(res);res.end(typeof value==='string'?value:JSON.stringify(value));return res}

test('fixed canonical route preserves schema and uses account credential only for completion',async t=>{
 const calls=transport(t,(_req,cb,_body,_options,url)=>reply(cb,url.endsWith('/health')?{status:'ok',upstream_healthy:true}:{model:'tarx/t-supercomputer',choices:[{message:{content:'{"status":"blocked"}'}}]}))
 const client=createSupercomputerPlannerClient({token,tokenLimit:1024})
 assert.equal(await client.ready(),true);assert.equal(await client.complete(messages,{...opts,maxTokens:9999}),'{"status":"blocked"}')
 assert.equal(calls[0].url,'https://compute.tarx.com/health');assert.equal(calls[0].options.headers.authorization,undefined)
 const sent=calls[1];assert.equal(sent.url,'https://compute.tarx.com/v1/chat/completions');assert.equal(sent.options.headers.authorization,'Bearer '+token);assert.equal(sent.options.agent,false);assert.equal(sent.options.rejectUnauthorized,undefined)
 const body=JSON.parse(sent.body);assert.equal(body.model,'tarx/t-supercomputer');assert.deepEqual(body.messages,messages);assert.equal(body.max_tokens,1024);assert.equal(body.chat_template_kwargs.enable_thinking,false);assert.deepEqual(body.response_format.json_schema.schema,schema)
 assert.equal(JSON.stringify(client).includes(token),false)
})
test('no credential/URL override, missing schema and invalid messages fail before network',async t=>{
 const calls=transport(t,()=>assert.fail('no request expected'))
 for(const bad of ['',token+'\n','service-key',undefined,token.toUpperCase()])assert.throws(()=>createSupercomputerPlannerClient({token:bad as any}))
 const client=createSupercomputerPlannerClient({token});assert.equal(await client.complete(messages),null);assert.equal(await client.complete([{role:'tool',content:'no'}],opts),null);assert.equal(await client.complete([{role:'user',content:'x'.repeat(32769)}],opts),null);assert.equal(calls.length,0)
})
test('redirects and auth failures stop without a second request or credential forwarding',async t=>{
 let status=302;const calls=transport(t,(_req,cb)=>{const res:any=new PassThrough();res.statusCode=status;res.headers={location:'https://foreign.invalid'};cb(res);res.end('')})
 const client=createSupercomputerPlannerClient({token})
 for(const code of [302,307,401,403,429,502]){status=code;const before=calls.length;assert.equal(await client.complete(messages,opts),null);assert.equal(calls.length,before+1)}
 assert.ok(calls.every(x=>x.url==='https://compute.tarx.com/v1/chat/completions'))
})
test('socket close before response settles instead of clearing the timer and hanging',async t=>{
 transport(t,req=>req.emit('close'));const client=createSupercomputerPlannerClient({token})
 assert.equal(await client.complete(messages,opts),null);assert.equal(await client.ready(),false)
})
test('pre-abort makes no request; in-flight abort destroys the request and settles',async t=>{
 let request:any;const calls=transport(t,req=>{request=req});const client=createSupercomputerPlannerClient({token});const controller=new AbortController();controller.abort()
 assert.equal(await client.complete(messages,{...opts,signal:controller.signal}),null);assert.equal(calls.length,0)
 const live=new AbortController();const pending=client.complete(messages,{...opts,signal:live.signal});await Promise.resolve();live.abort();assert.equal(await pending,null);assert.equal(request.destroyed,true)
})
test('oversized, malformed, empty or wrong-model replies cannot become a planner action',async t=>{
 let value:any;transport(t,(_req,cb)=>reply(cb,value));const client=createSupercomputerPlannerClient({token})
 for(const candidate of ['x'.repeat(65537),'{malformed',{model:'different',choices:[{message:{content:'unsafe'}}]},{model:'tarx/t-supercomputer',choices:[{message:{content:''}}]}]){value=candidate;assert.equal(await client.complete(messages,opts),null)}
})
test('a stalled completion hits its deadline without retries',async t=>{
 const calls=transport(t,()=>{});t.mock.timers.enable({apis:['setTimeout']});const client=createSupercomputerPlannerClient({token});const pending=client.complete(messages,opts);t.mock.timers.tick(10000);assert.equal(await pending,null);assert.equal(calls.length,1)
})

test('canonical client composes with actual planner parser without granting false done',async t=>{
 const {createScopedComputerPlanner}=await import('./tarx-computer-planner.ts')
 let content='{"status":"done"}'
 transport(t,(_req,cb)=>reply(cb,{model:'tarx/t-supercomputer',choices:[{message:{content}}]}))
 const client=createSupercomputerPlannerClient({token})
 const planner=createScopedComputerPlanner(client,[{command:'click',role:'button',name:'Open browser'}])
 const input=[{role:'user',content:'Goal: open the browser\nHistory:\n(none)\nObservation:\n[7] button "Open browser"'}]
 assert.deepEqual(JSON.parse((await planner.complete(input))!),{status:'blocked'})
 content='{"status":"act","action":{"command":"click","target":7},"expect":{"kind":"none"}}'
 assert.equal(JSON.parse((await planner.complete(input))!).action.target,7)
 content='{"status":"act","action":{"command":"click","target":99},"expect":{"kind":"none"}}'
 assert.equal(await planner.complete(input),null)
})

test('request/schema bounds and malformed runtime options stop before egress',async t=>{
 const calls=transport(t,()=>assert.fail('invalid request must not leave the host'));const client=createSupercomputerPlannerClient({token})
 for(const options of [null,[],{jsonSchema:new Date()},{jsonSchema:{description:'x'.repeat(8193)}},{...opts,signal:{}},{...opts,maxTokens:NaN}])assert.equal(await client.complete(messages,options),null)
 assert.equal(await client.complete([{role:'user',content:'x'.repeat(32768)},{role:'user',content:'x'.repeat(32768)}],opts),null)
 assert.equal(calls.length,0)
})
