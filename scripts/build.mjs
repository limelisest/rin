// Dependency-free build glue: application code lives in src/**/*.ts.
import {spawn} from 'node:child_process';
import {mkdtemp,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const stage=await mkdtemp(join(root,'.build-'));
try {
  const code=await new Promise((accept,reject)=>{
    const child=spawn(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--project',join(root,'tsconfig.json'),'--outDir',stage],{cwd:root,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>accept(code ?? 1));
  });
  if(code!==0)process.exitCode=code;
  else {await rm(join(root,'dist'),{recursive:true,force:true});await rename(stage,join(root,'dist'));}
} finally {await rm(stage,{recursive:true,force:true});}
