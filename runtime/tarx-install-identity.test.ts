import test from 'node:test'
import assert from 'node:assert/strict'
import fs,{mkdtemp,readFile,writeFile,readdir,stat,rm} from 'node:fs/promises'
import {syncBuiltinESMExports} from 'node:module'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {installIdentity} from './tarx-runtime-entry.ts'

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

test('a delayed identity writer never exposes an incomplete installation to a second caller',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-install-identity-')),entered=deferred(),release=deferred(),original=fs.open
 let held=false,first:Promise<{id?:string;error?:unknown}>|undefined,timer:ReturnType<typeof setTimeout>|undefined
 fs.open=(async(...args:Parameters<typeof fs.open>)=>{
  const handle=await original(...args)
  if(!held&&typeof args[0]==='string'&&dirname(args[0])===dir&&args[1]==='wx'){
   held=true
   return new Proxy(handle,{get(target,key){
    if(key==='writeFile')return async(...values:Parameters<typeof handle.writeFile>)=>{entered.resolve();await release.promise;return target.writeFile(...values)}
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
   }})
  }
  return handle
 }) as typeof fs.open
 syncBuiltinESMExports()
 try{
  first=installIdentity(dir).then(id=>({id}),error=>({error}))
  await Promise.race([entered.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('writer checkpoint missing')),2000)})])
  if(timer)clearTimeout(timer)
  const second=await installIdentity(dir)
  release.resolve();const result=await first
  assert.equal(result.error,undefined);assert.equal(result.id,second)
  assert.equal(await readFile(join(dir,'install-id'),'utf8'),second)
  assert.deepEqual(await readdir(dir),['install-id'])
  assert.equal((await stat(join(dir,'install-id'))).mode&0o777,0o600)
 }finally{if(timer)clearTimeout(timer);release.resolve();await first;fs.open=original;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true})}
})

test('invalid existing identity is preserved rather than rotated or repaired implicitly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-install-invalid-'))
 try{
  await writeFile(join(dir,'install-id'),'install_partial',{mode:0o600})
  await assert.rejects(()=>installIdentity(dir),/invalid_install_identity/)
  assert.equal(await readFile(join(dir,'install-id'),'utf8'),'install_partial')
  assert.deepEqual(await readdir(dir),['install-id'])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('concurrent installation callers keep one stable private identity and no owned staging files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-install-concurrent-'))
 try{
  const ids=await Promise.all(Array.from({length:32},()=>installIdentity(dir)))
  assert.equal(new Set(ids).size,1);assert.match(ids[0],/^install_[a-f0-9]{48}$/)
  assert.equal(await installIdentity(dir),ids[0]);assert.deepEqual(await readdir(dir),['install-id'])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a failed identity write removes only its owned staging file and can explicitly retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-install-write-failure-')),original=fs.open
 fs.open=(async(...args:Parameters<typeof fs.open>)=>{
  const handle=await original(...args)
  return new Proxy(handle,{get(target,key){
   if(key==='writeFile')return async()=>{throw Error('synthetic write failure')}
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
 }) as typeof fs.open;syncBuiltinESMExports()
 try{
  await assert.rejects(()=>installIdentity(dir),/synthetic write failure/)
  assert.deepEqual(await readdir(dir),[])
  fs.open=original;syncBuiltinESMExports()
  assert.match(await installIdentity(dir),/^install_[a-f0-9]{48}$/)
 }finally{fs.open=original;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true})}
})

test('failed no-replace publication preserves other staging files and creates no visible identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-install-publish-failure-')),original=fs.link
 const other=join(dir,'.install-id-other-writer.tmp')
 await writeFile(other,'synthetic other staging file',{mode:0o600})
 fs.link=(async()=>{throw Object.assign(Error('synthetic link unavailable'),{code:'EIO'})}) as typeof fs.link;syncBuiltinESMExports()
 try{
  await assert.rejects(()=>installIdentity(dir),/synthetic link unavailable/)
  assert.deepEqual(await readdir(dir),['.install-id-other-writer.tmp'])
  assert.equal(await readFile(other,'utf8'),'synthetic other staging file')
  fs.link=original;syncBuiltinESMExports()
  assert.match(await installIdentity(dir),/^install_[a-f0-9]{48}$/)
  assert.equal(await readFile(other,'utf8'),'synthetic other staging file')
 }finally{fs.link=original;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true})}
})

test('cleanup failure after publication is unconfirmed and a retry adopts the same identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-install-cleanup-failure-')),original=fs.unlink
 fs.unlink=(async()=>{throw Object.assign(Error('synthetic cleanup unavailable'),{code:'EACCES'})}) as typeof fs.unlink;syncBuiltinESMExports()
 try{
  await assert.rejects(()=>installIdentity(dir),/synthetic cleanup unavailable/)
  const published=await readFile(join(dir,'install-id'),'utf8');assert.match(published,/^install_[a-f0-9]{48}$/)
  assert.equal((await readdir(dir)).length,2)
  fs.unlink=original;syncBuiltinESMExports()
  assert.equal(await installIdentity(dir),published)
 }finally{fs.unlink=original;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true})}
})
