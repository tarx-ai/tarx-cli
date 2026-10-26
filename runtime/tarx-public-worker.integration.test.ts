import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {setTimeout as wait} from 'node:timers/promises'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createOwnedPublicWorker} from './tarx-owned-worker.ts'
import {createBoundedTaskController,createEveReadNoteExecutor,TASK_NAME,PUBLIC_NOTE} from './tarx-bounded-task.ts'
import {runRuntimeEntry} from './tarx-runtime-entry.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
test('authenticated Eve task and owned-worker recovery',{skip:process.env.TARX_TEST_WORKER!=='1',timeout:120000},async()=>{
 const {Client}=await import(pathToFileURL(createRequire(resolve('package.json')).resolve('eve/client')).href)
 const parent=await mkdtemp(join(tmpdir(),'tarx-protected-')),root=join(parent,'worker'),home=join(parent,'home');let calls=0
 const model=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const data=JSON.parse(body);calls++;const seen=data.messages?.some((m:any)=>m.role==='tool');const delta=seen?{role:'assistant',content:PUBLIC_NOTE}:{role:'assistant',tool_calls:[{index:0,id:'note',type:'function',function:{name:TASK_NAME,arguments:'{}'}}]};res.writeHead(200,{'content-type':'text/event-stream'});for(const [d,f]of [[delta,null],[{},seen?'stop':'tool_calls']])res.write('data: '+JSON.stringify({id:'mock',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:d,finish_reason:f}]})+'\n\n');res.end('data: [DONE]\n\n')})
 await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));const mp=(model.address() as any).port
 const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()))
 let worker:Awaited<ReturnType<typeof createOwnedPublicWorker>>|undefined
 try{
 worker=await createOwnedPublicWorker({root,home,eveRoot:resolve('.'),modelBaseURL:`http://127.0.0.1:${mp}/v1`,modelId:'mock',port})
 await worker.start();assert.equal(await worker.verify(),true);await assert.rejects(worker.start(),/already_owned/)
 const host=worker.host
 await assert.rejects(new Client({host}).sessions.create());assert.equal(calls,0)
 const client=worker.client,executor=createEveReadNoteExecutor(client,worker.verify),owners=createFileOwnerStore(join(parent,'owners.json')),file=join(parent,'tasks.json')
 const factory=()=>createBoundedTaskController({file,owners,executor}),identity={subject_id:'tvs_'+'a'.repeat(32),install_id:'fixture',task_scopes:[TASK_NAME]},body={request_id:'request_real_0001',task:TASK_NAME}
 const submitted=await factory().submit(identity,body);assert.equal(submitted.code,202,JSON.stringify(submitted));let result:any
 for(let i=0;i<120;i++){result=await factory().read(identity,body.request_id);if(['completed','failed'].includes(result.body.status))break;await wait(250)}
 assert.equal(result.body.status,'completed',JSON.stringify(result));assert.equal(result.body.receipt.result,PUBLIC_NOTE)
 const before=calls;await worker.stop();assert.equal(await worker.verify(),false);await worker.start();assert.deepEqual(await factory().read(identity,body.request_id),result);assert.equal((await factory().submit(identity,body)).body.status,'completed')
 const events=[];for await(const event of executor.events(result.body.session_id))events.push(event);assert.equal(events.filter((e:any)=>e.type==='action.result').length,1);assert.equal(calls,before)
 await worker.stop()
 const state=join(parent,'entry-state'),key=join(parent,'fixture-key');await writeFile(key,'tarx_cli_'+'f'.repeat(64))
 const challenge:any=await runRuntimeEntry(['challenge','--state-dir',state,'--credential-file',key],{fetcher:(async()=>new Response(JSON.stringify({ok:true,subject_id:identity.subject_id}))) as typeof fetch})
 assert.equal(challenge.ok,true);await runRuntimeEntry(['approve','--state-dir',state,'--challenge',challenge.challenge,'--task',TASK_NAME])
 const running:any=await runRuntimeEntry(['serve-check','--state-dir',state,'--worker-root',join(parent,'entry-worker'),'--eve-root',resolve('.'),'--model-url',`http://127.0.0.1:${mp}/v1`,'--model-id','mock','--worker-port',String(port),'--port','0'])
 try{
 const base='http://127.0.0.1:'+running.address.port,origin='https://www.tarx.com'
 const claim=await(await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:challenge.challenge})})).json()
 const headers={origin,'content-type':'application/json',authorization:'Bearer '+claim.pairing_credential}
 assert.deepEqual(await(await fetch(base+'/task-capabilities',{headers})).json(),{available_tasks:[TASK_NAME],permitted_tasks:[TASK_NAME]})
 assert.equal((await fetch(base+'/tasks',{method:'POST',headers,body:JSON.stringify({...body,request_id:'entry_task_0001'})})).status,202)
 let receipt:any;for(let i=0;i<120;i++){receipt=await(await fetch(base+'/tasks/entry_task_0001',{headers})).json();if(receipt.status==='completed')break;await wait(250)}assert.equal(receipt.receipt?.result,PUBLIC_NOTE)
 const count=calls;assert.equal((await fetch(base+'/tasks',{method:'POST',headers,body:JSON.stringify({...body,request_id:'entry_task_0001'})})).status,200);assert.equal(calls,count)
 }finally{await running.listener.close()}
 }finally{await worker?.stop();await new Promise<void>(r=>model.close(()=>r()));await rm(parent,{recursive:true,force:true})}
})
