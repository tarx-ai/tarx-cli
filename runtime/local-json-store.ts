import {mkdir,open,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {randomBytes} from 'node:crypto'

/** Local atomic store. Never steals a stale lock; contention fails closed. */
export function createLocalJsonStore<T>(path:string){
 path=resolve(path)
 async function transact<R>(operation:(records:Record<string,T>)=>{result:R;write?:boolean}):Promise<R>{
  await mkdir(dirname(path),{recursive:true,mode:0o700})
  let lock:Awaited<ReturnType<typeof open>>|undefined
  for(let i=0;i<200;i++){
   try{lock=await open(path+'.lock','wx',0o600);break}
   catch(error:any){if(error.code!=='EEXIST')throw error;await new Promise(r=>setTimeout(r,5))}
  }
  if(!lock)throw Error('local_store_busy')
  try{
   let records:Record<string,T>={}
   try{records=JSON.parse(await readFile(path,'utf8'));if(!records||typeof records!=='object'||Array.isArray(records))throw Error('invalid_local_store')}
   catch(error:any){if(error.code!=='ENOENT')throw error}
   const outcome=operation(records)
   if(outcome.write){
    const temp=path+'.'+randomBytes(12).toString('hex')+'.tmp'
    try{await writeFile(temp,JSON.stringify(records),{mode:0o600,flag:'wx'});await rename(temp,path)}
    finally{await unlink(temp).catch((e:any)=>{if(e.code!=='ENOENT')throw e})}
   }
   return outcome.result
  }finally{await lock.close();await unlink(path+'.lock')}
 }
 return {transact,get:(key:string)=>transact(all=>({result:all[key]??null})),put:(key:string,value:T)=>transact(all=>{all[key]=value;return {result:undefined,write:true}}),values:()=>transact(all=>({result:Object.values(all)}))}
}
