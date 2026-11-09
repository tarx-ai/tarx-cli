import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import {open,mkdtemp,mkdir,writeFile,realpath,rm,symlink,rename} from 'node:fs/promises'
import {syncBuiltinESMExports} from 'node:module'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {verifyComputerArtifacts,type ComputerArtifacts} from './tarx-computer-executor.ts'
const hash=(bytes:string)=>createHash('sha256').update(bytes).digest('hex')
async function fixture(t:any){
 const root=await realpath(await mkdtemp(join(tmpdir(),'tarx-artifact-size-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const core=join(root,'core');await mkdir(core)
 const files=Object.fromEntries(['adapter.js','refs.js','policy.js','loop.js','model.js','package.json'].map(name=>[name,'fixture']))
 for(const [name,body]of Object.entries(files))await writeFile(join(core,name),body)
 const small=join(root,'small');await writeFile(small,'fixture')
 const artifacts:ComputerArtifacts={coreSource:'a'.repeat(40),coreDirectory:core,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,hash(b)])),node:{path:small,sha256:hash('fixture')},adapter:{path:small,sha256:hash('fixture')}}
 return {root,artifacts}
}
async function sparse(path:string,size:number){
 const h=await open(path,'wx');try{await h.truncate(size)}finally{await h.close()}
}
async function sparseHash(size:number){
 const h=createHash('sha256'),chunk=Buffer.alloc(1024*1024)
 for(let left=size;left>0;left-=chunk.length)h.update(left>=chunk.length?chunk:chunk.subarray(0,left))
 return h.digest('hex')
}
test('verified Node payload may exceed 128 MiB while adapter/core limits remain unchanged',async t=>{
 const f=await fixture(t),file=join(f.root,'large-node'),size=128*1024*1024+1
 await sparse(file,size);const checked={path:file,sha256:await sparseHash(size)}
 await verifyComputerArtifacts({...f.artifacts,node:checked})
 await assert.rejects(verifyComputerArtifacts({...f.artifacts,adapter:checked}),/mismatch/)
 const module=join(f.artifacts.coreDirectory,'adapter.js');await rm(module);await sparse(module,size)
 await assert.rejects(verifyComputerArtifacts({...f.artifacts,node:checked,files:{...f.artifacts.files,'adapter.js':checked.sha256}}),/mismatch/)
})
test('Node remains capped and hash-bound; oversized, changed and linked files fail',async t=>{
 const f=await fixture(t),file=join(f.root,'oversized-node')
 await sparse(file,256*1024*1024+1)
 await assert.rejects(verifyComputerArtifacts({...f.artifacts,node:{path:file,sha256:'0'.repeat(64)}}),/mismatch/)
 const changed=join(f.root,'changed');await writeFile(changed,'changed')
 await assert.rejects(verifyComputerArtifacts({...f.artifacts,node:{path:changed,sha256:hash('fixture')}}),/mismatch/)
 const linked=join(f.root,'linked');await symlink(f.artifacts.node.path,linked)
 await assert.rejects(verifyComputerArtifacts({...f.artifacts,node:{path:linked,sha256:hash('fixture')}}),/mismatch/)
})

// Intercept the opened descriptor, then change its file after the first read.
// This verifies race rejection without timing-dependent filesystem watchers.
test('artifact replacement, growth and truncation during hashing fail closed',async t=>{
 for(const mutation of ['replace','grow','truncate']){
  const f=await fixture(t),file=join(f.root,'race-node'),body='x'.repeat(128*1024)
  await writeFile(file,body)
  const original=fs.open.bind(fs);let changed=false
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
   const handle=await original(...args)
   if(String(args[0])===file){
    const read=handle.read.bind(handle)
    t.mock.method(handle,'read',async(...values:any[])=>{
     const result=await (read as any)(...values)
     if(!changed&&result.bytesRead){
      changed=true
      if(mutation==='replace'){await rename(file,file+'.old');await writeFile(file,body)}
      else if(mutation==='grow')await writeFile(file,body+'changed')
      else await writeFile(file,'short')
     }
     return result
    })
   }
   return handle
  })
  syncBuiltinESMExports()
  try{await assert.rejects(verifyComputerArtifacts({...f.artifacts,node:{path:file,sha256:hash(body)}}),/mismatch/);assert.equal(changed,true)}
  finally{t.mock.restoreAll();syncBuiltinESMExports()}
 }
})
