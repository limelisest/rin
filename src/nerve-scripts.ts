import {readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';

/** Supervise user-owned Node producers; their protocols and schedules stay outside Nerve. */
export class ScriptDirectory {
  private children=new Set<ChildProcess>();
  private timers=new Set<NodeJS.Timeout>();
  private stopped=false;
  constructor(private directory:string,private env:NodeJS.ProcessEnv,private log:(name:string,error:string)=>void){}
  async start(){
    const entries=await readdir(resolve(this.directory),{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.isFile() && entry.name.endsWith('.mjs'))this.launch(join(resolve(this.directory),entry.name),0);
    }
  }
  private launch(file:string,failures:number){
    if(this.stopped)return;
    const began=Date.now();
    const child=spawn(process.execPath,[file],{cwd:resolve(this.directory),env:{...process.env,...this.env},stdio:['ignore','inherit','inherit']});
    this.children.add(child);
    child.on('error',error=>this.log(file,error.message));
    child.once('close',(code,signal)=>{
      this.children.delete(child);
      if(this.stopped)return;
      this.log(file,`Exited ${signal || code}`);
      const next=Date.now()-began>60000?0:Math.min(failures+1,6);
      const timer=setTimeout(()=>{this.timers.delete(timer);this.launch(file,next);},Math.min(60000,1000*2**next));
      this.timers.add(timer);
    });
  }
  async stop(){
    this.stopped=true;for(const timer of this.timers)clearTimeout(timer);this.timers.clear();
    await Promise.all([...this.children].map(child=>new Promise<void>(done=>{
      child.once('close',()=>{clearTimeout(timer);done();});
      const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
      child.kill('SIGTERM');
    })));
  }
}
