import {validateArchiveExact} from './archive-exact-validation';
import type {ReproductionFile} from './scan-reproduction';

self.onmessage=async(event:MessageEvent<ReproductionFile>)=>{
  try{const valid=await validateArchiveExact(event.data,new AbortController().signal);self.postMessage({ok:true,valid});}
  catch{self.postMessage({ok:false});}
};
