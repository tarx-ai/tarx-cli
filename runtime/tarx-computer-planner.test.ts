import test from 'node:test'
import assert from 'node:assert/strict'
import {createScopedComputerPlanner} from './tarx-computer-planner.ts'
const actions=[{command:'click',role:'button',name:'Allowed control'}]
const input=[{role:'system',content:'old broad prompt'},{role:'user',content:'Goal: use the allowed control\nHistory:\n(none)\nObservation:\n[2] textfield "Private field" value="do not send"\n[7] button "Allowed control" {Press}\n[9] button "Other control" {Press}'}]
function fixture(output:string){let sent:any;const planner=createScopedComputerPlanner({modelId:'fixture',endpoint:'http://127.0.0.1:1',complete:async(messages,opts)=>{sent={messages,opts};return output}},actions,'User-selected context');return {planner,sent:()=>sent}}
test('scoped producer preserves current handles and sends only eligible controls with bounded structured output',async()=>{
 const f=fixture('{"status":"act","action":{"command":"click","target":7},"expect":{"kind":"none"}}')
 assert.equal(JSON.parse((await f.planner.complete(input))!).action.target,7)
 const sent=f.sent();assert.deepEqual(sent.opts.jsonSchema.properties.action.properties.target.enum,[7])
 assert.doesNotMatch(JSON.stringify(sent.messages),/do not send|Other control|old broad prompt/)
 assert.match(sent.messages[1].content,/User-selected context/);assert.equal(sent.opts.maxTokens,256)
})
test('fabricated refs, outside-scope targets, extra authority and malformed output cannot become actions',async()=>{
 for(const output of ['not JSON','[]','{"status":"done","approved":true}','{"status":"act","action":{"command":"click","target":9},"expect":{"kind":"none"}}','{"status":"act","action":{"command":"click","ref":"@fixed:e1"},"expect":{"kind":"none"}}'])
  assert.equal(await fixture(output).planner.complete(input),null)
})
test('producer false-done is blocked before an action; no eligible control causes no model call',async()=>{
 assert.deepEqual(JSON.parse((await fixture('{"status":"done"}').planner.complete(input))!),{status:'blocked'})
 const f=fixture('{"status":"done"}')
 assert.deepEqual(JSON.parse((await f.planner.complete([{role:'user',content:'Goal: no control\nObservation:\n[1] textfield "Private field"'}]))!),{status:'blocked'})
 assert.equal(f.sent(),undefined)
})

test('native observation projection keeps approved original refs beyond browser chrome and drops unrelated data',async()=>{
 const {scopeNativeObservation}=await import('./tarx-computer-planner.ts')
 const tree={ref_id:'@fresh:e1',role:'window',name:'Private window title',children:[
  ...Array.from({length:100},(_,i)=>({ref_id:'@fresh:e'+(i+2),role:'button',name:'Unapproved chrome '+i})),
  {ref_id:'@fresh:e200',role:'group',value:'private ancestor value',children:[{ref_id:'@fresh:e201',role:'button',name:'Allowed control',states:['enabled']}]},
 ]}
 const projected=scopeNativeObservation(tree,actions)
 assert.doesNotMatch(JSON.stringify(projected),/Unapproved|Private window|private ancestor/)
 assert.deepEqual(projected,{children:[{children:[{ref_id:'@fresh:e201',role:'button',name:'Allowed control',states:['enabled'],children:undefined}]}]})
})

test('local producer uses the approved loopback endpoint, bounds output and disables per-request thinking without changing configuration',async()=>{
 const {createServer}=await import('node:http'),{createLoopbackPlannerClient}=await import('./tarx-computer-planner.ts')
 let payload:any
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;payload=JSON.parse(raw);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"status":"blocked"}'}}]}))})
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const client=createLoopbackPlannerClient({baseURL:'http://127.0.0.1:'+address.port,model:'fixture-local-model'})
  assert.equal(await client.complete([{role:'user',content:'Synthetic public goal'}],{maxTokens:999}),'{"status":"blocked"}')
  assert.equal(payload.model,'fixture-local-model');assert.equal(payload.max_tokens,256);assert.deepEqual(payload.chat_template_kwargs,{enable_thinking:false})
  for(const baseURL of ['https://foreign.test','http://127.0.0.1:1/other','http://127.0.0.1:1/v1?key=x'])assert.throws(()=>createLoopbackPlannerClient({baseURL,model:'fixture'}))
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
})

test('an offline/denied request does not count as model generation; a received invalid decision does',async()=>{
 let generations=0
 for(const raw of [null,'not valid JSON','{"status":"blocked"}']){
  const planner=createScopedComputerPlanner({modelId:'fixture',endpoint:'http://127.0.0.1:1',complete:async()=>raw},actions,undefined,()=>generations++)
  await planner.complete(input)
 }
 assert.equal(generations,2)
})

test('planner exposes bounded failure categories without retaining or exposing raw model output',async()=>{
 const invalid=fixture('private invalid response')
 await invalid.planner.complete(input);assert.equal(invalid.planner.decisionStatus,'invalid_json')
 const falseDone=fixture('{"status":"done"}')
 await falseDone.planner.complete(input);assert.equal(falseDone.planner.decisionStatus,'false_done')
 assert.doesNotMatch(JSON.stringify(invalid.planner),/private invalid response/)
})

test('model readiness consumes the complete response and verifies the configured identity; HTTP 200 alone is insufficient',async()=>{
 const {createServer}=await import('node:http'),{createLoopbackPlannerClient}=await import('./tarx-computer-planner.ts')
 let mode='incomplete'
 const server=createServer((_req,res)=>{if(mode==='incomplete'){res.writeHead(200);res.flushHeaders();res.destroy();return}res.end(JSON.stringify({data:[{id:mode==='ready'?'fixture':'other'}]}))})
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 try{
  const a=server.address();assert.ok(a&&typeof a!=='string')
  const client=createLoopbackPlannerClient({baseURL:'http://127.0.0.1:'+a.port,model:'fixture'})
  assert.equal(await client.ready(),false);mode='wrong';assert.equal(await client.ready(),false);mode='ready';assert.equal(await client.ready(),true)
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
})

test('a shortened display label keeps the fresh native handle for its full approved name',async()=>{
 const name='Open the browser for the approved channel and inspect its current task result'
 const shown=name.slice(0,60)+'…'
 const text='[5] button '+JSON.stringify(shown)+' {Press}'
 let sent:any
 const planner=createScopedComputerPlanner({modelId:'fixture',endpoint:'http://127.0.0.1:1',complete:async(messages,opts)=>{
  sent={messages,opts};return '{"status":"act","action":{"command":"click","target":5},"expect":{"kind":"none"}}'
 }},[{command:'click',role:'button',name}],undefined,undefined,()=>({text,controls:[{handle:5,role:'button',name}]}))
 const decision=JSON.parse((await planner.complete([{role:'user',content:'Goal: open the browser\nHistory:\n(none)\nObservation:\n'+text}]))!)
 assert.equal(decision.status,'act');assert.equal(decision.action.target,5)
 assert.deepEqual(sent.opts.jsonSchema.properties.action.properties.target.enum,[5])
 assert.match(sent.messages[1].content,new RegExp(name))
})

test('display-name collisions do not grant access to a different full native name',async()=>{
 const prefix='Open the browser for the approved channel and inspect its current task '
 const approved=prefix+'result',other=prefix+'private settings'
 const text='[1] button '+JSON.stringify(prefix.slice(0,60)+'…')+'\n[2] button '+JSON.stringify(prefix.slice(0,60)+'…')
 let sent:any
 const planner=createScopedComputerPlanner({modelId:'fixture',endpoint:'http://127.0.0.1:1',complete:async(messages,opts)=>{
  sent={messages,opts};return '{"status":"act","action":{"command":"click","target":2},"expect":{"kind":"none"}}'
 }},[{command:'click',role:'button',name:approved}],undefined,undefined,()=>({text,controls:[{handle:1,role:'button',name:approved},{handle:2,role:'button',name:other}]}))
 assert.equal(await planner.complete([{role:'user',content:'Goal: open\nObservation:\n'+text}]),null)
 assert.deepEqual(sent.opts.jsonSchema.properties.action.properties.target.enum,[1])
 assert.doesNotMatch(sent.messages[1].content,/private settings/)
})

test('stale observation text and previous-frame handles fail closed',async()=>{
 let calls=0,handle=7
 const text=()=>`[${handle}] button "Allowed control"`
 const planner=createScopedComputerPlanner({modelId:'fixture',endpoint:'http://127.0.0.1:1',complete:async()=>{
  calls++;return '{"status":"act","action":{"command":"click","target":7},"expect":{"kind":"none"}}'
 }},actions,undefined,undefined,()=>({text:text(),controls:[{handle,role:'button',name:'Allowed control'}]}))
 const old=[{role:'user',content:'Goal: open\nObservation:\n'+text()}]
 assert.equal(JSON.parse((await planner.complete(old))!).action.target,7)
 handle=9
 assert.equal(await planner.complete(old),null)
 assert.equal(calls,1,'stale frames must not reach the provider')
 assert.equal(await planner.complete([{role:'user',content:'Goal: open\nObservation:\n'+text()}]),null)
 assert.equal(calls,2,'an old target is rejected even if a provider returns it for a fresh frame')
})
