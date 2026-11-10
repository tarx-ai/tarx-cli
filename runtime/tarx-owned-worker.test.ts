import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {spawn,type ChildProcess} from 'node:child_process'
import {once} from 'node:events'
import {stopOwnedWorkerChild} from './tarx-owned-worker.ts'

function fixture(){
 const child=Object.assign(new EventEmitter(),{pid:19001,exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,kill:(_signal?:NodeJS.Signals):boolean=>false})
 const exit=(signal:NodeJS.Signals='SIGTERM')=>{child.signalCode=signal;child.emit('exit',null,signal);child.emit('close',null,signal)}
 return {child:child as unknown as ChildProcess,raw:child,exit}
}
function clean(child:ChildProcess){assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('close'),0)}

for(const kind of ['code','signal'] as const)test(`exited owned child (${kind}) cannot authorize any group signal`,async()=>{
 const f=fixture(),signals:unknown[]=[]
 if(kind==='code')f.raw.exitCode=0;else f.raw.signalCode='SIGTERM'
 await stopOwnedWorkerChild(f.child,{signalGroup:(...args)=>{signals.push(args)}})
 assert.deepEqual(signals,[]);clean(f.child)
})

test('TERM exit is acknowledged without a later KILL or a port probe',async()=>{
 const f=fixture(),signals:string[]=[]
 await stopOwnedWorkerChild(f.child,{graceMs:5,exitMs:5,signalGroup:(pid,signal)=>{assert.equal(pid,19001);signals.push(signal);queueMicrotask(()=>f.exit(signal))}})
 assert.deepEqual(signals,['SIGTERM']);clean(f.child)
})

test('a live owned leader escalates once and awaits its exit',async()=>{
 const f=fixture(),signals:string[]=[]
 await stopOwnedWorkerChild(f.child,{graceMs:1,exitMs:20,signalGroup:(_pid,signal)=>{signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>f.exit(signal))}})
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);clean(f.child)
})

test('group-signal failure falls back to the owned handle and acknowledges exit',async()=>{
 const f=fixture(),fallback:string[]=[]
 f.raw.kill=(signal?:NodeJS.Signals)=>{fallback.push(signal!);queueMicrotask(()=>f.exit(signal));return true}
 await stopOwnedWorkerChild(f.child,{graceMs:5,exitMs:5,signalGroup:()=>{throw Error('fixture permission denied')}})
 assert.deepEqual(fallback,['SIGTERM']);clean(f.child)
})

test('unconfirmed exit rejects and releases listeners for explicit retry',async()=>{
 const f=fixture(),signals:string[]=[]
 await assert.rejects(stopOwnedWorkerChild(f.child,{graceMs:1,exitMs:1,signalGroup:(_pid,signal)=>{signals.push(signal)}}),/owned_worker_stop_timeout/)
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);clean(f.child)
 f.exit();await stopOwnedWorkerChild(f.child,{signalGroup:()=>assert.fail('reaped retry cannot signal')});clean(f.child)
})

test('concurrent stop shares one flight and one TERM',async()=>{
 const f=fixture(),signals:string[]=[]
 const options={graceMs:10,exitMs:10,signalGroup:(_pid:number,signal:NodeJS.Signals)=>{signals.push(signal);queueMicrotask(()=>f.exit(signal))}}
 const first=stopOwnedWorkerChild(f.child,options),second=stopOwnedWorkerChild(f.child,options)
 assert.equal(first,second);await Promise.all([first,second]);assert.deepEqual(signals,['SIGTERM']);clean(f.child)
})


test('default shutdown acknowledges one actual owned disposable process',async()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
 try{
  await once(child,'spawn')
  await stopOwnedWorkerChild(child,{graceMs:100,exitMs:1000})
  assert.ok(child.exitCode!==null||child.signalCode!==null)
  clean(child)
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}
 }
})
