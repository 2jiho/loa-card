import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNameReader} from '../src/features/card-scanner/name-reader';
import {confirmName,confirmCatalogName} from '../src/features/card-scanner/name-confidence';
import {CardReadBudget} from '../src/features/card-scanner/card-read-budget';
import type {NameAttempt} from '../src/features/card-scanner/name-diagnostics';
import type {RecognitionPixels,NameLabelRecipe} from '../src/features/card-scanner/recognition-input-observer';

test('rejected dictionary corrections cannot trap full OCR behind a name cache; exact names remain reusable',async()=>{
  const previousWorker=globalThis.Worker,previousDocument=globalThis.document;
  let calls=0,answer='벨루마트',fullAnswer:string|undefined,labelVisible=true;
  const heights:number[]=[];
  class FakeWorker {
    onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
    postMessage(message:{id:number;type:string;height?:number}){
      if(message.type==='recognize'){calls++;heights.push(message.height!);}
      const text=message.height===36&&fullAnswer!==undefined?fullAnswer:answer;
      queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:{text,confidence:.98}}}));
    }
    terminate(){}
  }
  // One deterministic label raster drives the real mask/cache code. The Worker
  // alone is stubbed so a fresh inference is observable without model downloads.
  class FakeCanvas {
    width=140;height=210;
    getContext(){return {
      drawImage(){},clearRect(){},
      getImageData:(_x:number,_y:number,w:number,h:number)=>{
        const data=new Uint8ClampedArray(w*h*4);
        for(let y=2;labelVisible&&y<Math.min(14,h);y++)for(let x=12;x<Math.min(72,w);x++)if(x%5<2){
          const p=(y*w+x)*4;data[p]=20;data[p+1]=180;data[p+2]=220;data[p+3]=255;
        }
        return {data};
      },
    };}
  }
  globalThis.Worker=FakeWorker as unknown as typeof Worker;
  globalThis.document={createElement:()=>new FakeCanvas()} as unknown as Document;
  const reader=createNameReader([{id:'card',name:'벨루마테',rarity:2}]);
  const source=new FakeCanvas() as unknown as HTMLCanvasElement;
  const labels:{pixels:RecognitionPixels;recipe:NameLabelRecipe}[]=[];
  try{
    await reader.ready();
    const first=await reader.match(source,true,0,true,undefined,new CardReadBudget(1000),false,
      (pixels,recipe)=>{labels.push({pixels,recipe});});
    assert.equal(labels.length,1);assert.equal(labels[0].pixels.data.byteLength,128*36*4);
    assert.deepEqual(labels[0].recipe,{region:'initial-name-label',sourceBox:{x:6,y:14,width:128,height:36},
      targetWidth:128,targetHeight:36,offsetY:0,quick:true,allowRaw:true,bypassCache:false});
    const retainedLabel=labels[0].pixels.data.slice();
    assert.ok(first);assert.equal(first.exact,false);
    assert.equal(confirmName(first,false),true);
    assert.equal(confirmCatalogName(first,false),false);
    assert.equal(calls,1);
    await reader.match(source,true,0,true,undefined,new CardReadBudget(1000));
    assert.equal(calls,2,'a later crop must not inherit the rejected correction');
    // The first-line model still makes the identical mistake. Full retry must
    // actually reach the complete-name variant, not return that hypothesis again.
    fullAnswer='벨루마테';
    const retry:NameAttempt[]=[];
    const second=await reader.match(source,false,0,true,a=>retry.push(a),new CardReadBudget(1000),true);
    assert.equal(second?.exact,true);assert.equal(calls,5);
    assert.deepEqual(heights,[18,18,18,18,36]);
    assert.ok(retry.some(a=>a.engine==='paddle'));
    const cached:NameAttempt[]=[];
    let cachedLabels=0;
    const third=await reader.match(source,true,0,true,a=>cached.push(a),new CardReadBudget(1000),false,
      ()=>{cachedLabels++;throw Error('optional label retention failed');});
    assert.equal(cachedLabels,1,'label delivery does not imply a new neural inference');
    assert.equal(third?.exact,true);assert.equal(calls,5);
    assert.ok(cached.some(a=>a.engine==='cache'&&a.reason==='확정 이름 캐시 재사용'));
    answer='벨루마테';
    const bypassed:NameAttempt[]=[];
    await reader.match(source,false,0,true,a=>bypassed.push(a),new CardReadBudget(1000),true);
    assert.equal(calls,6);
    assert.ok(bypassed.some(a=>a.engine==='cache'&&a.reason.includes('캐시 우회')));
    labelVisible=false;
    const rejected:NameAttempt[]=[];
    assert.equal(await reader.match(source,true,0,false,a=>rejected.push(a),new CardReadBudget(1000)),null);
    assert.equal(calls,6);
    assert.ok(rejected.some(a=>a.engine==='quality'&&a.reason.includes('OCR 미실행')));
    assert.deepEqual(labels[0].pixels.data,retainedLabel,'later masks do not mutate the retained initial RGBA array');
  }finally{reader.dispose();globalThis.Worker=previousWorker;globalThis.document=previousDocument;}
});
