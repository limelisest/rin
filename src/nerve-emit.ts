import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export interface EventInput{id:string;target:string;payload:unknown;source?:string}
/** Producers retain their event until this durable admission receipt arrives. */
export async function emitEvent(event:EventInput,{endpoint=process.env.NERVE_ENDPOINT,token=process.env.NERVE_TOKEN,timeoutMs=15000}={}){
  if(!endpoint || !token)throw new Error('NERVE_ENDPOINT and NERVE_TOKEN required');
  const url=new URL('/events',endpoint);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Nerve must be a loopback HTTP endpoint');
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(event),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok){await response.body?.cancel();throw new Error(`Nerve admission failed: HTTP ${response.status}`);}
  const receipt=await response.json() as {id?:string;inserted?:boolean};
  if(receipt.id!==event.id || typeof receipt.inserted!=='boolean')throw new Error('Invalid admission receipt');
  return receipt;
}
export async function main(){let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1048576)throw new Error('Input too large');}process.stdout.write(JSON.stringify(await emitEvent(JSON.parse(text)))+'\n');}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
