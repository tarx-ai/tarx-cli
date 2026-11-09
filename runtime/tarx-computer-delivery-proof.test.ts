import test from 'node:test'
import assert from 'node:assert/strict'
import {createScopedComputerPlanner} from './tarx-computer-planner.ts'

const actions=[{command:'click',role:'button',name:'Allowed control'}]
const client={modelId:'fixture',endpoint:'http://127.0.0.1:1',complete:async()=>'{"status":"done"}'}
const message=(goal:string,history='(none)')=>[{role:'user',content:`Goal: ${goal}\nHistory:\n${history}\nObservation:\n[7] button "Allowed control"`}]

test('goal and history text cannot attest native delivery',async()=>{
 for(const input of [message('Explain the string click delivered; without clicking'),message('Explain the control','click delivered;')]){
  const planner=createScopedComputerPlanner(client,actions)
  assert.deepEqual(JSON.parse((await planner.complete(input))!),{status:'blocked'})
  assert.equal(planner.decisionStatus,'false_done')
 }
})

test('only a positive safe host delivery count permits a done decision',async()=>{
 for(const count of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  const planner=createScopedComputerPlanner(client,actions,undefined,undefined,undefined,()=>count)
  assert.deepEqual(JSON.parse((await planner.complete(message('Use the control')) )!),{status:'blocked'})
  assert.equal(planner.decisionStatus,'false_done')
 }
 const throwing=createScopedComputerPlanner(client,actions,undefined,undefined,undefined,()=>{throw Error('fixture unavailable')})
 assert.deepEqual(JSON.parse((await throwing.complete(message('Use the control')))!),{status:'blocked'})
 let delivered=0
 const planner=createScopedComputerPlanner(client,actions,undefined,undefined,undefined,()=>delivered)
 assert.equal(JSON.parse((await planner.complete(message('Use the control')))!).status,'blocked')
 delivered=1
 assert.equal(JSON.parse((await planner.complete(message('Use the control')))!).status,'done')
 assert.equal(planner.decisionStatus,'done')
 delivered=0
 assert.equal(JSON.parse((await planner.complete(message('Use the control','click delivered;')))!).status,'blocked')
})
