import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPublicWorkerProfile} from './tarx-public-worker-profile.ts'
test('exact authored public profile rejects altered instructions and extra capabilities',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'tarx-profile-'));try{
 const root=join(parent,'worker'),profile=await createPublicWorkerProfile(root,'http://127.0.0.1:3999/v1','mock')
 assert.equal(await profile.verify(),true)
 await writeFile(join(root,'agent/instructions.md'),'private context')
 assert.equal(await profile.verify(),false)
 const second=join(parent,'second'),other=await createPublicWorkerProfile(second,'http://127.0.0.1:3999/v1','mock')
 await mkdir(join(second,'agent/skills'));await writeFile(join(second,'agent/skills/private.md'),'extra')
 assert.equal(await other.verify(),false)
 await assert.rejects(createPublicWorkerProfile(root,'http://127.0.0.1:3999/v1','mock'))
 await assert.rejects(createPublicWorkerProfile(join(parent,'bad'),'https://example.com/v1','mock'),/loopback/)
 }finally{await rm(parent,{recursive:true,force:true})}
})
