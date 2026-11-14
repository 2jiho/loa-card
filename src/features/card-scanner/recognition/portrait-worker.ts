/** Ranks a crop's artwork against every reference (portrait-matcher.ts `rank`) off the main thread.
 *
 * The recognizer's name reading checks the artwork of every crop it reads; ranking it against the
 * whole catalogue is the heavy part of that check and ran on the main thread, where the scan's
 * frame handling and the progress window wait for it. The decision itself (the acceptance gates,
 * with the name read as evidence) stays with the recognizer, on this worker's ranking.
 *
 * The references are the recognizer's: the same files, built by the same matcher.
 * In: `{id, gray}` (the crop's 24x32 gray grid). Out: `{id, ranking}`, null when it cannot be ranked. */
import {createPortraitMatcher,screenExtraReferences} from './portrait-matcher';
import type {PortraitRanking} from './portrait-matcher';
import {loadPortraitCompetitors} from './portrait-competitors';
import type {Reference} from './reference-types';

export interface PortraitRankRequest {readonly id:number;readonly gray:Float32Array}
export interface PortraitRankReply {readonly id:number;readonly ranking:PortraitRanking|null}

const scope=self as unknown as {onmessage:((event:MessageEvent<PortraitRankRequest>)=>void)|null;postMessage(message:PortraitRankReply):void};
let preparing:Promise<ReturnType<typeof createPortraitMatcher>>|undefined;
async function prepare() {
  const base=new URL(import.meta.env.BASE_URL,self.location.href).href;
  const load=async(name:string)=>{const response=await fetch(base+'scanner/'+name,{signal:AbortSignal.timeout(30_000)});if(!response.ok)throw Error('원화 대조 자료 로드 실패: '+name);return response.json();};
  const [catalog,atlas,screen,competitors,extra,extra1080,extra0625]=await Promise.all([load('cards.json'),load('artwork-details.json'),
    load('screen-artwork-details.json'),loadPortraitCompetitors(base),load('screen-artwork-extra.json'),load('screen-artwork-1080.json'),load('screen-artwork-0625.json')]);
  return createPortraitMatcher(catalog.cards as Reference[],atlas,screen.cards,{competitors,
    extra:[...screenExtraReferences(extra),...screenExtraReferences(extra1080),...screenExtraReferences(extra0625)]});
}
scope.onmessage=event=>{
  const {id,gray}=event.data;
  void (async()=>{
    try{scope.postMessage({id,ranking:(await (preparing??=prepare())).rank(gray)});}
    catch{scope.postMessage({id,ranking:null});}
  })();
};
