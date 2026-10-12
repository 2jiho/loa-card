import {defineConfig,mergeConfig} from 'vite';
import {readFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import base from '../../vite.config';
import {recognitionExperiment} from './plugin';

export default defineConfig(({command})=>{
  if(command!=='serve')throw Error('Recognition experiment is local-only; use the normal config for builds.');
  const root=process.cwd(),directory=resolve(process.env.LOACARD_COMPOSED_DIR??'work/composed-card-templates');
  const within=relative(resolve(root,'work'),directory);
  if(!within||within.startsWith('..')||isAbsolute(within))throw Error('LOACARD_COMPOSED_DIR must be below work/');
  const read=(file:string)=>JSON.parse(readFileSync(resolve(directory,file),'utf8'));
  const normal=read('normal-details.json'),equipped=read('equipped-details.json'),experiment=read('masked-details.json');
  const catalogDirectory=resolve(process.env.LOACARD_CATALOG_DIR??'work/client-card-references');
  const catalogWithin=relative(resolve(root,'work'),catalogDirectory);
  if(!catalogWithin||catalogWithin.startsWith('..')||isAbsolute(catalogWithin))throw Error('LOACARD_CATALOG_DIR must be below work/');
  const catalog=JSON.parse(readFileSync(resolve(catalogDirectory,'cards.json'),'utf8'));
  return mergeConfig(base,{base:'/',server:{host:'127.0.0.1',port:5201,strictPort:true},plugins:[recognitionExperiment(),{
    name:'local-composed-reference-data',configureServer(server){
      server.middlewares.use((req,res,next)=>{
        const path=req.url?.split('?')[0];
        const data=path==='/scanner/cards.json'?catalog:path==='/scanner/artwork-details.json'?normal:
          path==='/scanner/screen-artwork-details.json'?{cards:equipped,experiment}:undefined;
        if(!data){next();return;}
        res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));
      });
    },
  }]});
});
