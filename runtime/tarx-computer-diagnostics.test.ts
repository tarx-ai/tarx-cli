import test from 'node:test'
import assert from 'node:assert/strict'
import {actionDiagnostics,adapterDelivery,controlCategory,controlCounts,verificationState} from './tarx-computer-diagnostics.ts'

test('control categories are exact and never copy a label',()=>{
 assert.equal(controlCategory({role:'button',name:'Open browser'}),'browser_open')
 assert.equal(controlCategory({role:'button',name:'Close browser'}),'browser_close')
 assert.equal(controlCategory({role:'button',name:'Browser active'}),'browser_close')
 assert.equal(controlCategory({role:'button',name:'Open browser settings'}),'button')
 assert.equal(controlCategory({role:'menuitem',name:'Open browser'}),'menu_item')
 assert.equal(controlCategory({role:'textfield',name:'Open browser'}),'text_field')
 assert.equal(controlCategory({role:'statictext',name:'Close browser'}),'other')
 assert.equal(controlCategory(null),'other')
})

test('pane-control counts read the raw tree and stay bounded',()=>{
 const tree={role:'window',name:'private title',children:[
  {role:'button',name:'Open browser'},
  {role:'group',children:[{role:'button',name:'Close browser'},{role:'button',name:'Browser active'}]},
  {role:'button',name:'Settings'},
 ]}
 assert.deepEqual(controlCounts(tree),{open:1,close:2})
 assert.deepEqual(controlCounts(null),{open:0,close:0})
})

test('adapter delivery is read only from the bounded disposition and steps',()=>{
 assert.deepEqual(adapterDelivery({disposition:{delivery:'delivered_unverified'},steps:[{mechanism:'semantic_api',verified:false}]}),{delivery:'delivered_unverified',mechanism:'semantic_api'})
 assert.deepEqual(adapterDelivery({disposition:{delivery:'not_a_value'},steps:[{mechanism:'physical_synthetic'}]}),{delivery:'unknown',mechanism:'physical_synthetic'})
 assert.deepEqual(adapterDelivery(null),{delivery:'unknown',mechanism:'unknown'})
})

test('observed_only is not a failed action postcondition',()=>{
 assert.equal(verificationState([{decision:'act',verification:{check:'observed_only',passed:false}}]),'none')
 assert.equal(verificationState([{decision:'act',verification:{check:'enabled',passed:false}}]),'failed')
 assert.equal(verificationState([{decision:'act',verification:{check:'enabled',passed:true}}]),'passed')
 assert.equal(verificationState([{decision:'done'}]),'none')
})

test('diagnostics drop unknown fields and keep before/after pane evidence',()=>{
 const diagnostics=actionDiagnostics({node:{role:'button',name:'Open browser'},data:{disposition:{delivery:'delivered_unverified'},steps:[{mechanism:'semantic_api'}]},focused:false,before:{open:1,close:0},after:{open:1,close:0},steps:[{decision:'act',verification:{check:'observed_only',passed:false}}]})
 assert.deepEqual(diagnostics,{control:'browser_open',delivery:'delivered_unverified',mechanism:'semantic_api',verification:'none',focused:false,before:{open:1,close:0},after:{open:1,close:0}})
 assert.equal(JSON.stringify(diagnostics).includes('Open browser'),false)
 const malformed=actionDiagnostics({node:{role:'button',name:'Open browser'},data:{},focused:'yes',before:{open:99,close:-1},after:undefined})
 assert.deepEqual(malformed,{control:'browser_open',delivery:'unknown',mechanism:'unknown',verification:'none'})
})
