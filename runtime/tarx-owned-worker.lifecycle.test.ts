import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,access,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {setTimeout as wait} from 'node:timers/promises'
import {createOwnedPublicWorker} from './tarx-owned-worker.ts'

async function until(check:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await wait(10)}assert.fail('bounded fixture checkpoint missing')}
async function exists(path:string){try{await access(path);return true}catch{return false}}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'tarx-owned-lifecycle-')),base=join(directory,'deps'),root=join(directory,'worker')
 const pkg=join(base,'node_modules/eve');await mkdir(join(pkg,'bin'),{recursive:true})
 await writeFile(join(base,'package.json'),'{}')
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'eve',version:'0.83.2',type:'module',exports:{'./package.json':'./package.json','./client':'./client.mjs'}}))
 await writeFile(join(pkg,'client.mjs'),`export class Client{async info(){return {tools:{static:[{name:'read_launch_note'}],dynamic:[]}}}}`)
 await writeFile(join(pkg,'bin/eve.js'),`import {mkdir,writeFile,access} from 'node:fs/promises';import {setTimeout as wait} from 'node:timers/promises';import {createServer} from 'node:http';await mkdir('.output',{recursive:true});if(process.argv[2]==='build'){await writeFile('.output/build-pid',String(process.pid));while(true){try{await access('.output/release-build');break}catch{await wait(10)}}}else{await writeFile('.output/worker-started',String(process.pid));const port=Number(process.argv[process.argv.indexOf('--port')+1]);createServer((req,res)=>{if(req.url==='/eve/v1/health'){res.end('{}')}else{res.statusCode=401;res.end('{}')}}).listen(port,'127.0.0.1')}`)
 const reservation=createServer();await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve)})
 const port=(reservation.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()))
 const worker=await createOwnedPublicWorker({root,home:join(directory,'home'),eveRoot:base,modelBaseURL:'http://127.0.0.1:1/v1',modelId:'fixture-no-inference',port})
 return {root,worker,async close(start?:Promise<unknown>){await writeFile(join(root,'.output/release-build'),'fixture cleanup').catch(()=>{});await start;await worker.stop();await rm(directory,{recursive:true,force:true})}}
}

test('Stop during the owned build waits for cancellation and never spawns a worker without its lock',async()=>{
 const f=await fixture();let start:Promise<unknown>|undefined
 try{
  start=f.worker.start().then(()=>({ok:true}),error=>({error}))
  await until(()=>exists(join(f.root,'.output/build-pid')))
  const stopping=f.worker.stop()
  await assert.rejects(async()=>f.worker.start(),/worker_stopping/)
  await stopping
  const outcome=await start as {ok?:boolean;error?:Error}
  assert.equal(outcome.ok,undefined);assert.ok(outcome.error)
  assert.equal(await exists(join(f.root,'.runtime.lock')),false)
  assert.equal(await exists(join(f.root,'.output/worker-started')),false)
  const pid=Number(await readFile(join(f.root,'.output/build-pid'),'utf8'))
  assert.throws(()=>process.kill(pid,0),(error:any)=>error.code==='ESRCH')
 }finally{await f.close(start)}
})

test('stopped build can explicitly restart; concurrent Stop tolerates its already-removed owned lock',async()=>{
 const f=await fixture();let start:Promise<unknown>|undefined
 try{
  start=f.worker.start().catch(error=>error)
  await until(()=>exists(join(f.root,'.output/build-pid')))
  await f.worker.stop();await start
  await writeFile(join(f.root,'.output/release-build'),'fixture')
  await f.worker.start();assert.equal(await f.worker.verify(),true)
  // This is only the fixture's own reservation; no other owner's lock is touched.
  await rm(join(f.root,'.runtime.lock'),{recursive:true})
  const first=f.worker.stop(),second=f.worker.stop();assert.equal(first,second)
  await Promise.all([first,second]);assert.equal(await f.worker.verify(),false)
 }finally{await f.close(start)}
})

test('Stop preserves a replacement reservation instead of removing another owner',async()=>{
 const f=await fixture();let start:Promise<unknown>|undefined
 const lock=join(f.root,'.runtime.lock'),foreign=join(lock,'synthetic-other-owner')
 try{
  await mkdir(join(f.root,'.output'),{recursive:true});await writeFile(join(f.root,'.output/release-build'),'fixture')
  start=f.worker.start();await start
  // Only this test's private fixture is replaced; no real owner's reservation is touched.
  await rm(lock,{recursive:true});await mkdir(lock);await writeFile(foreign,'synthetic reservation')
  let stopError:unknown
  try{await f.worker.stop()}catch(error){stopError=error}
  assert.equal(await exists(foreign),true,'replacement reservation must survive Stop')
  assert.match(String(stopError),/owned_worker_lock_changed/)
  assert.equal(await readFile(foreign,'utf8'),'synthetic reservation')
 }finally{
  // The synthetic replacement is ours to clean up after the owned worker exits.
  await rm(lock,{recursive:true,force:true});await f.close(start)
 }
})


test('Stop preserves unexpected reservation contents and can retry after fixture reconciliation',async()=>{
 const f=await fixture();let start:Promise<unknown>|undefined
 const lock=join(f.root,'.runtime.lock'),extra=join(lock,'synthetic-unknown-entry')
 try{
  await mkdir(join(f.root,'.output'),{recursive:true});await writeFile(join(f.root,'.output/release-build'),'fixture')
  start=f.worker.start();await start
  const entries=await readdir(lock);assert.equal(entries.length,1);assert.match(entries[0],/^\.owner-[a-f0-9]{32}$/)
  await writeFile(extra,'synthetic contents')
  await assert.rejects(f.worker.stop(),/owned_worker_lock_changed/)
  assert.equal(await exists(join(lock,entries[0])),true)
  assert.equal(await readFile(extra,'utf8'),'synthetic contents')
  // Reconcile only the extra entry created by this fixture, then retry Stop.
  await rm(extra);await f.worker.stop();assert.equal(await exists(lock),false)
 }finally{await rm(extra,{force:true});await f.close(start)}
})


test('a failed acquisition never removes the fixture reservation it did not create',async()=>{
 const f=await fixture();let start:Promise<unknown>|undefined
 const lock=join(f.root,'.runtime.lock'),marker=join(lock,'synthetic-other-owner')
 try{
  await mkdir(lock);await writeFile(marker,'synthetic reservation')
  start=f.worker.start().catch(error=>error)
  assert.match(String(await start),/EEXIST/)
  await f.worker.stop();assert.equal(await readFile(marker,'utf8'),'synthetic reservation')
 }finally{await rm(lock,{recursive:true,force:true});await f.close(start)}
})

test('Stop rejects a symlink replacement without traversing its target',async()=>{
 const f=await fixture();let start:Promise<unknown>|undefined
 const lock=join(f.root,'.runtime.lock'),target=join(f.root,'.output/synthetic-replacement')
 try{
  await mkdir(join(f.root,'.output'),{recursive:true});await writeFile(join(f.root,'.output/release-build'),'fixture')
  start=f.worker.start();await start
  await rm(lock,{recursive:true});await mkdir(target);await writeFile(join(target,'preserve'),'synthetic data')
  await symlink(target,lock)
  await assert.rejects(f.worker.stop(),/owned_worker_lock_changed/)
  assert.equal(await readFile(join(target,'preserve'),'utf8'),'synthetic data')
 }finally{await rm(lock,{force:true,recursive:true});await f.close(start)}
})
