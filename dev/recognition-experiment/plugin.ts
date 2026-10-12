import type { Plugin } from 'vite';
import {patchRecovery} from './recovery-transform';

/** Dev-only opt-in. Exact replacements fail closed on source drift. */
export function recognitionExperiment():Plugin {
  const replace=(source:string,from:string,to:string)=>{
    if(!source.includes(from))throw Error('Recognition experiment patch is stale: '+from);
    return source.replace(from,to);
  };
  return {name:'asset-aware-recognition-experiment',apply:'serve',enforce:'pre',transform(code,id){
    const file=id.split('?')[0].replaceAll('\\','/');
    if(!file.includes('/src/features/card-scanner/'))return;
    if(file.endsWith('/recognizer.ts')||file.endsWith('/visual-worker.ts')) {
      code=code.replace(/from (["'])\.\/portrait-matcher\1/g,"from '/dev/recognition-experiment/portrait'");
      if(file.endsWith('/recognizer.ts')) {
        code=replace(code,'screen.cards);','screen.cards, screen.experiment);');
        code=replace(code,'canvas.height), text);','canvas.height), text, {pixels,width:canvas.width,height:canvas.height});');
      } else {
        code=replace(code,'screen.cards),','screen.cards,screen.experiment),');
        code=replace(code,'image.width,image.height));','image.width,image.height),undefined,{pixels,width:image.width,height:image.height});');
      }
    }
    if(file.endsWith('/card-acquisition.ts')) {
      code=replace(code,'import { alignCardBorders } from "./card-borders";',
        'import { alignCardBorders, visibleIdentity } from "/dev/recognition-experiment/geometry";\nimport {identityObservation} from "/dev/recognition-experiment/identity-observation";');
      code=replace(code,'const result:Cell =',`if(complete&&!intact&&labelVisible&&region&&quality.reason.startsWith('카드 테두리 불완전')&&
        visibleIdentity(region.data,region.width,region.height,{...content,x:content.x-left,y:content.y-top},layout.scale)) {
        Object.assign(quality,{usable:true,identityOnly:true,reason:'상단 확인 · 이름만 판독 · 하단 재관측 필요'});
      }
      const result:Cell =`);
      code=replace(code,'if (sourcePixels && content.x >= left+1',
        'if ((quality as typeof quality & {identityOnly?:boolean}).identityOnly) result.feature=identityObservation(result.feature);\n    if (sourcePixels && content.x >= left+1');
    }
    if(file.endsWith('/scanner.ts')) {
      code=patchRecovery(code);
      code=replace(code,'type Candidate = {','type Candidate = { identityOnly?:boolean;');
      code=replace(code,'captures.offerDetailed(observations[i], i % 10,',
        'captures.offerDetailed(observations[i], i % 10 + ((quality as typeof quality & {identityOnly?:boolean}).identityOnly?10:0),');
      code=replace(code,'group: group.id, trace,','group: group.id, trace, identityOnly: (quality as typeof quality & {identityOnly?:boolean}).identityOnly,');
      code=replace(code,'const target = quick ? fullRetries : deferred;',
        'if(item.identityOnly&&(!unknown||quick))return false;\n        const target = quick ? fullRetries : deferred;');
      code=replace(code,'!quick && (isStill || !queued || deferred.length >= 512),',
        '!item.identityOnly && !quick && (isStill || !queued || deferred.length >= 512),');
      code=replace(code,'let values = visualResult?.values ?? await reader!.read(item.image, identity.id, false, !fast);',
        'let values = item.identityOnly ? {awakening:null,extraCopies:null,countDiagnostics:undefined} : visualResult?.values ?? await reader!.read(item.image, identity.id, false, !fast);');
    }
    return code;
  }};
}
