import test from 'node:test'
import assert from 'node:assert/strict'
import {returnedFailure} from './tarx-computer-failure.ts'

test('a returned core-loop action error is bounded to adapter/code',()=>{
 assert.deepEqual(returnedFailure({outcome:'max_steps',steps:[{result:'error',errorCode:'ACTION_FAILED'}]}),{failure_stage:'adapter',failure_code:'ACTION_FAILED'})
})
test('a returned core-loop verification failure is bounded separately',()=>{
 assert.deepEqual(returnedFailure({outcome:'max_steps',steps:[{result:'delivered',verification:{passed:false}}]}),{failure_stage:'verification',failure_code:'native_step_unverified'})
})

test('observed_only is not reported as a native action verification failure',()=>{
 assert.deepEqual(returnedFailure({outcome:'max_steps',steps:[{decision:'act',result:'delivered',verification:{check:'observed_only',passed:false}}]}),{failure_stage:'verification',failure_code:'max_steps'})
 assert.deepEqual(returnedFailure({outcome:'unverified',steps:[{decision:'act',result:'delivered',verification:{check:'enabled',passed:false}}]}),{failure_stage:'verification',failure_code:'native_step_unverified'})
})
