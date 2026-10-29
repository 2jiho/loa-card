import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {CardReadBudget,CardReadTimeout} from '../src/features/card-scanner/card-read-budget';

test('recognizer policies preserve evidence and isolate invocation diagnostics and request metrics',async()=>{
  // Node does not supply Vite's build constant. Provide only that constant to
  // the real module; do not replace its recognizer, reader or timeout logic.
  let providedBase=false;
  const hooks=registerHooks({load(url,context,nextLoad){
    const result=nextLoad(url,context);
    if(url.endsWith('/src/features/card-scanner/recognizer.ts')){
      const source=String(result.source);
      assert.ok(source.includes('import.meta.env.BASE_URL'));
      providedBase=true;
      return {...result,source:source.replaceAll('import.meta.env.BASE_URL',"'/'")};
    }
    return result;
  }});
  const previous={Worker:globalThis.Worker,document:globalThis.document,fetch:globalThis.fetch};
  const workers:FakeWorker[]=[];
  let inferenceCalls=0,canvasReads=0;
  let answer=(height?:number)=>{void height;return '사이카';};
  class FakeWorker {
    onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
    terminated=false;
    constructor(){workers.push(this);}
    postMessage(message:{id:number;type:string;height?:number}){
      if(message.type==='recognize')inferenceCalls++;
      const text=answer(message.height);
      queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:{text,confidence:.99}}}));
    }
    terminate(){this.terminated=true;}
  }
  class FakeCanvas {
    width=140;height=210;pixels=new Uint8ClampedArray(140*210*4);
    getContext(){return {
      drawImage:(source:FakeCanvas,...rect:number[])=>{
        let sx=0,sy=0,sw=source.width,sh=source.height,dx=0,dy=0,dw=sw,dh=sh;
        if(rect.length===2)[dx,dy]=rect;
        else if(rect.length===4)[dx,dy,dw,dh]=rect;
        else if(rect.length===8)[sx,sy,sw,sh,dx,dy,dw,dh]=rect;
        else throw Error('Unexpected drawImage shape');
        const next=new Uint8ClampedArray(this.width*this.height*4);
        for(let y=0;y<dh;y++)for(let x=0;x<dw;x++){
          const from=(Math.floor(sy+y*sh/dh)*source.width+Math.floor(sx+x*sw/dw))*4;
          const to=((dy+y)*this.width+dx+x)*4;
          next.set(source.pixels.subarray(from,from+4),to);
        }
        this.pixels=next;
      },
      getImageData:(left:number,top:number,width:number,height:number)=>{
        canvasReads++;
        const data=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const from=((top+y)*this.width+left+x)*4;
          data.set(this.pixels.subarray(from,from+4),(y*width+x)*4);
        }
        return {data,width,height};
      },
      clearRect:()=>{this.pixels.fill(0);},
    };}
  }
  const responses:Record<string,unknown>={
    '/scanner/cards.json':{cards:[{id:'saika',name:'사이카',rarity:2},{id:'belu',name:'벨루마테',rarity:2}]},
    '/scanner/artwork-details.json':{},
    '/scanner/screen-artwork-details.json':{cards:{}},
    '/scanner/stars.json':{gray:[new Array(170).fill(0)],gold:[new Array(170).fill(255)]},
    '/scanner/counter-patterns.json':{patterns:[]},
  };
  globalThis.Worker=FakeWorker as unknown as typeof Worker;
  globalThis.document={createElement:()=>new FakeCanvas()} as unknown as Document;
  globalThis.fetch=(async(input)=>{
    const value=responses[String(input)];assert.notEqual(value,undefined,`Unexpected fetch ${String(input)}`);
    return {ok:true,json:async()=>structuredClone(value)} as Response;
  }) as typeof fetch;
  let recognizer:Awaited<ReturnType<typeof import('../src/features/card-scanner/recognizer').createRecognizer>>|undefined;
  try{
    const {createRecognizer}=await import('../src/features/card-scanner/recognizer');
    assert.equal(providedBase,true);
    recognizer=await createRecognizer(()=>{});
    const first=new FakeCanvas(),other=new FakeCanvas();
    for(const canvas of [first,other])for(let y=16;y<28;y++)for(let x=18;x<78;x++)if(x%5<2){
      const offset=(y*140+x)*4;canvas.pixels.set([20,180,220,255],offset);
    }
    const source=first as unknown as HTMLCanvasElement,unrelated=other as unknown as HTMLCanvasElement;
    const prior=await recognizer.identify(source,false,true,true,new CardReadBudget(3000));
    assert.equal(prior?.id,'saika');
    const firstPortraits=recognizer.portraitDiagnostics(source);
    assert.ok(firstPortraits?.length);assert.equal(firstPortraits[0].mode,'visual');
    assert.equal(firstPortraits[0].source,'computed');assert.ok(Object.isFrozen(firstPortraits));
    const beforeCachedPortraitReads=canvasReads;
    recognizer.portrait(source);
    assert.equal(canvasReads,beforeCachedPortraitReads,'cached rejected portraits do not remeasure pixels for diagnostics');
    assert.equal(recognizer.portraitDiagnostics(source)?.[0].source,'cached');
    assert.equal(firstPortraits[0].source,'computed','already returned packets retain their original measurement provenance');
    assert.equal(recognizer.portraitDiagnostics(unrelated),null,'another crop cannot inherit portrait measurements');
    const firstMetrics=recognizer.namePerformance(source);
    assert.equal(firstMetrics?.policy,'resample');assert.equal(firstMetrics?.requests,1);assert.equal(firstMetrics?.quickAccepted,1);
    assert.ok(Object.isFrozen(firstMetrics));
    const old=recognizer.nameDiagnostics(source);
    const oldSnapshot=structuredClone(old);
    assert.ok(old.some(a=>a.engine==='paddle'&&a.text==='사이카'),'seed a real reader diagnostic with the fake model result');
    await recognizer.identify(unrelated,false,true,true,new CardReadBudget(3000));
    const unrelatedDiagnostics=recognizer.nameDiagnostics(unrelated);
    const unrelatedMetrics=recognizer.namePerformance(unrelated);
    assert.ok(unrelatedDiagnostics.length>0);
    const callsBefore=inferenceCalls,readsBefore=canvasReads;
    // Inject a clock that advances only after construction: the same public
    // budget then fails exactly at identify's entry, before inspect/OCR.
    let clock=0;
    const deadline=new CardReadBudget(1,()=>clock);clock=1;
    await assert.rejects(recognizer.identify(source,true,true,true,deadline),CardReadTimeout);
    assert.deepEqual(recognizer.nameDiagnostics(source),[], 'the failed full invocation must not inherit its prior short-read evidence');
    assert.equal(recognizer.namePerformance(source),undefined,'entry failure cannot inherit another invocation metrics');
    assert.deepEqual(recognizer.portraitDiagnostics(source),[],'entry timeout cannot inherit a previous portrait measurement');
    assert.equal(recognizer.namePerformance(unrelated),unrelatedMetrics,'another canvas retains its own metrics snapshot');
    assert.deepEqual(recognizer.nameDiagnostics(unrelated),unrelatedDiagnostics,'another canvas keeps its own diagnostics');
    assert.deepEqual(old,oldSnapshot,'already returned diagnostics remain a separate snapshot');
    assert.equal(inferenceCalls,callsBefore,'entry timeout cannot dispatch another inference');
    assert.equal(canvasReads,readsBefore,'entry timeout cannot inspect or paint pixels');
    // The inverse call order has the same contract, even if the full call can
    // reuse the exact-name cache instead of dispatching a fresh inference.
    await recognizer.identify(source,true,true,true,new CardReadBudget(3000));
    assert.ok(recognizer.nameDiagnostics(source).length>0);
    const shortDeadline=new CardReadBudget(1,()=>clock);clock=2;
    const beforeShort={inferenceCalls,canvasReads};
    await assert.rejects(recognizer.identify(source,false,true,true,shortDeadline),CardReadTimeout);
    assert.deepEqual(recognizer.nameDiagnostics(source),[],'the failed short invocation must not inherit prior full-read evidence');
    assert.deepEqual({inferenceCalls,canvasReads},beforeShort);
    assert.deepEqual(recognizer.nameDiagnostics(unrelated),unrelatedDiagnostics);
    await recognizer.dispose();recognizer=undefined;
    answer=height=>height===36?'벨루마테':'벨루마트';
    const outcomes:unknown[]=[];
    for(const policy of ['resample','continue'] as const){
      recognizer=await createRecognizer(()=>{},undefined,{nameRawResultPolicy:policy});
      const before=inferenceCalls,result=await recognizer.identify(source,true,true,true,new CardReadBudget(3000));
      assert.equal(result?.id,'belu');assert.equal(result?.name,'벨루마테');assert.equal(result?.confidence,1);
      assert.deepEqual(result?.review,[]);assert.equal(result?.nameEvidence[0].complete,true);
      assert.equal(result?.nameEvidence[0].ocrConfidence,99);assert.equal(result?.nameEvidence[0].rawText,'벨루마테');
      const metrics=recognizer.namePerformance(source)!;
      assert.equal(metrics.policy,policy);assert.equal(metrics.requests,policy==='resample'?4:3);
      assert.equal(inferenceCalls-before,metrics.requests);assert.equal(metrics.reusedRequests,policy==='continue'?1:0);
      assert.equal(recognizer.nameOcrMetrics().requests,metrics.requests);
      assert.equal(recognizer.nameDiagnostics(source).filter(attempt=>attempt.variant==='원본 첫 줄').length,policy==='resample'?2:1);
      const {readingId:_random,...evidence}=result!.nameEvidence[0];outcomes.push({...result,nameEvidence:[evidence]});
      await recognizer.dispose();recognizer=undefined;
    }
    assert.deepEqual(outcomes[0],outcomes[1],'unconstrained fixed-provider identity/confidence/evidence is unchanged');
  } finally {
    await recognizer?.dispose();
    hooks.deregister();
    globalThis.Worker=previous.Worker;globalThis.document=previous.document;globalThis.fetch=previous.fetch;
    assert.ok(workers.every(worker=>worker.terminated),'all fake model workers are disposed');
  }
});
