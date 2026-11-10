import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {parseNativeScopeProposal,createLoopbackPlannerClient} from './tarx-computer-planner.ts'
import {validateNativeScope} from './tarx-computer-executor.ts'
const controls=[{handle:1,role:'button',name:'Show details'},{handle:2,role:'button',name:'Cancel'}]
const proposal={targets:[1],success:[{kind:'enabled',role:'button',name:'Details visible'}]}
test('scope proposals bind original visible handles and permit a future independently checked postcondition',()=>{
 assert.deepEqual(parseNativeScopeProposal(JSON.stringify(proposal),controls),{actions:[{command:'click',role:'button',name:'Show details'}],success:proposal.success})
})
test('malformed, oversized and authority-bearing proposals and ambiguous control metadata fail closed',()=>{
 for(const bad of [null,'not json','x'.repeat(8193),{...proposal,app:'foreign'},{...proposal,targets:[1,1]},{...proposal,targets:[9]},
  {...proposal,success:[{kind:'count',role:'button',name:'Details visible',count:11}]},{...proposal,success:[{kind:'enabled',role:'button',name:'-flag'}]},
  {...proposal,success:[{kind:'enabled',role:'button',name:'x'.repeat(200)}]},{...proposal,success:[...proposal.success,...proposal.success]}]){
  assert.equal(parseNativeScopeProposal(typeof bad==='string'?bad:JSON.stringify(bad),controls),null)
 }
 assert.equal(parseNativeScopeProposal(JSON.stringify(proposal),[...controls,{handle:3,role:'button',name:'Show details'}]),null)
 assert.equal(parseNativeScopeProposal(JSON.stringify(proposal),[...controls,{handle:1,role:'button',name:'Other'}]),null)
})
test('scope generation can use the explicit 1024-token host limit; ordinary step limit remains 256',async()=>{
 let output:any
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;output=JSON.parse(body);res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(proposal)}}]}))})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const client=createLoopbackPlannerClient({baseURL:'http://127.0.0.1:'+address.port,model:'fixture',tokenLimit:1024})
  await client.complete([{role:'user',content:'Fixture goal'}],{maxTokens:1024})
  assert.equal(output.max_tokens,1024);assert.equal(output.stream,false)
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
test('Stop aborts an outstanding scope-generation request and returns no proposal',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
 const server=createServer(req=>{req.resume();entered()})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const controller=new AbortController()
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const client=createLoopbackPlannerClient({baseURL:'http://127.0.0.1:'+address.port,model:'fixture',tokenLimit:1024})
  const response=client.complete([{role:'user',content:'Fixture goal'}],{maxTokens:1024,signal:controller.signal})
  await started;controller.abort();assert.equal(await response,null)
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
test('scope preparation model accounting cannot be forged on a deterministic task',()=>{
 const action={command:'click' as const,role:'button',name:'Show details'}
 const scope={app:'Fixture',window:{id:'w-1',pid:1,title_sha256:'a'.repeat(64)},actions:[action],success:proposal.success,mode:'local_model' as const,model:{baseURL:'http://127.0.0.1:12345',model:'fixture'},preparation_model_calls:1}
 assert.doesNotThrow(()=>validateNativeScope(scope as any,2))
 assert.throws(()=>validateNativeScope({...scope,preparation_model_calls:3} as any,2))
 assert.throws(()=>validateNativeScope({...scope,mode:'deterministic_actuator'} as any,2))
})
