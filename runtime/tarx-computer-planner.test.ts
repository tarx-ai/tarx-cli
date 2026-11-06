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
