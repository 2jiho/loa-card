import {createAcquisitionClient} from '../src/features/card-scanner/acquisition-client';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import {inspectVisual,readVisual} from '../src/features/card-scanner/visual-fields';
import {packCount,prepareContrastPattern,type CountPattern} from '../src/features/card-scanner/count-pattern';
import type {RasterContext} from '../src/features/card-scanner/acquisition-raster';

type Link={seq:number;sourceFrameId:number;acquisitionFrameId:number;phase:'input'|'recovery';captureTime:number};
type Target={acquisitionFrameId:number;available:boolean;reason?:string;link?:Link;receipts?:unknown[];header?:unknown;
 restored?:{width:number;height:number;bytes:number;sha256:string;url:string}};
type Manifest={kind:string;producerSourceDigest:string;original:{bytes:number;sha256:string};retained:unknown;targets:Target[];sourceStart:unknown;sourceEnd:unknown;sourceChanged:boolean};
type Region={name:string;x:number;y:number;width:number;height:number;bytes:Uint8Array<ArrayBuffer>;sha256:string};
const button=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector<HTMLElement>('#status')!,
 result=document.querySelector<HTMLElement>('#result')!,images=document.querySelector<HTMLElement>('#images')!;
const ensure=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const url=new URL(location.href),path=url.searchParams.get('manifest'),expectedManifestSha=url.searchParams.get('sha256');
let manifest:Manifest|undefined,manifestSha:string|undefined,active:AbortController|undefined;
window.addEventListener('pagehide',()=>active?.abort(new DOMException('Field proof page closed','AbortError')));
async function snapshot(signal:AbortSignal){const response=await fetch('/__corpus/environment',{signal,cache:'no-store'});ensure(response.ok,'실행 소스 확인 실패');return response.json();}
const rgba=(canvas:HTMLCanvasElement)=>{const data=canvas.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height).data;
 return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);};
function base64(bytes:Uint8Array){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
async function region(data:Uint8Array<ArrayBuffer>,name:string,x:number,y:number,width:number,height:number):Promise<Region>{
 ensure(x>=0&&y>=0&&x+width<=140&&y+height<=210,'필드 ROI 범위 오류');
 const pixels=new Uint8Array(width*height*4);for(let row=0;row<height;row++)pixels.set(data.subarray(((y+row)*140+x)*4,((y+row)*140+x+width)*4),row*width*4);
 return {name,x,y,width,height,bytes:pixels,sha256:await pixelHash(pixels)};
}
function compare(a:Region,b:Region){
 ensure(a.width===b.width&&a.height===b.height,'ROI 크기 불일치');let changedBytes=0,changedPixels=0,sum=0,max=0,channelSums=[0,0,0,0],channelDiff=[0,0,0,0];
 const deltas:number[]=[];
 for(let i=0;i<a.bytes.length;i+=4){let changed=false,pixelMax=0;for(let c=0;c<4;c++){
  const delta=Math.abs(a.bytes[i+c]-b.bytes[i+c]);if(delta){changedBytes++;changed=true;channelDiff[c]++;}sum+=delta;max=Math.max(max,delta);
  channelSums[c]+=delta;pixelMax=Math.max(pixelMax,delta);
 }if(changed)changedPixels++;deltas.push(pixelMax);}
 deltas.sort((x,y)=>x-y);const pixels=a.width*a.height;
 return {name:a.name,firstSha256:a.sha256,secondSha256:b.sha256,byteIdentical:a.sha256===b.sha256,bytes:a.bytes.length,pixels,
  changedBytes,changedPixels,meanAbsoluteByteDifference:sum/a.bytes.length,maxAbsoluteByteDifference:max,
  meanAbsoluteChannelDifference:channelSums.map(value=>value/pixels),changedChannelPixels:channelDiff,
  perPixelMaxDifference:{median:deltas[Math.floor(pixels*.5)],p95:deltas[Math.min(pixels-1,Math.floor(pixels*.95))]}};
}
void(async()=>{
 try{
  ensure(path&&/^\/work\/ninav-fields\/extraction-[a-f0-9]{64}\.json$/.test(path)&&expectedManifestSha&&/^[a-f0-9]{64}$/.test(expectedManifestSha),'URL에 내용 주소화 manifest와 SHA가 필요합니다.');
  const response=await fetch(path!,{cache:'no-store'});ensure(response.ok,'추출 manifest 읽기 실패');const bytes=new Uint8Array(await response.arrayBuffer());
  ensure(bytes.byteLength<1024*1024,'manifest 용량 초과');manifestSha=await pixelHash(bytes);ensure(manifestSha===expectedManifestSha,'추출 manifest SHA 불일치');
  manifest=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));ensure(manifest?.kind==='ninav-explicit-source-extraction'&&!manifest.sourceChanged,'잘못되거나 실행 중 변경된 추출 manifest');
  button.disabled=false;status.textContent='검증된 원본 연결 준비 완료 · 실제 획득 검사를 시작하세요.';
 }catch(error){status.textContent=String(error);}
})();
button.addEventListener('click',async()=>{
 if(active||!manifest)return;const controller=active=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]),started=performance.now();
 const acquisition=createAcquisitionClient(signal,{pixelTransport:true,pixelProof:true}),target=document.createElement('canvas'),normalized=document.createElement('canvas');
 normalized.width=140;normalized.height=210;const context=normalized.getContext('2d',{willReadFrequently:true})!;
 let sourceStart:unknown=null,sourceEnd:unknown=null;const history:unknown[]=[],fields:{originalAcquisitionFrameId:number;regions:Region[];report:Record<string,unknown>}[]=[];
 button.disabled=true;images.replaceChildren();result.textContent='';status.textContent='실제 획득 Worker를 준비합니다.';
 try{
  sourceStart=await snapshot(signal);
  const [starsResponse,patternsResponse]=await Promise.all([fetch('/scanner/stars.json',{signal}),fetch('/scanner/counter-patterns.json',{signal})]);
  ensure(starsResponse.ok&&patternsResponse.ok,'기존 필드 템플릿 읽기 실패');const stars=await starsResponse.json(),atlas=await patternsResponse.json() as {patterns:CountPattern[]};
  const templates=[stars.gray[0],stars.gold[0]],patterns=atlas.patterns.map(prepareContrastPattern);
  await acquisition.ready();
  const ordered=manifest.targets.filter(row=>row.available&&row.acquisitionFrameId<=10);
  ensure(ordered.length===10&&ordered.every((row,index)=>row.acquisitionFrameId===index+1),'최초 10개 실제 사용 순서가 모두 필요합니다.');
  for(const row of ordered){
   signal.throwIfAborted();const input=row.restored!,link=row.link!;
   ensure(/^\/work\/ninav-fields\/[a-f0-9]{64}\.rgba$/.test(input.url)&&input.bytes===input.width*input.height*4&&input.bytes<=64*1024*1024,'추출 원본 파일 범위 오류');
   const response=await fetch(input.url,{signal,cache:'no-store'});ensure(response.ok,'복원 RGBA 읽기 실패');const pixels=new Uint8Array(await response.arrayBuffer());
   ensure(pixels.byteLength===input.bytes&&await pixelHash(pixels)===input.sha256,'복원 RGBA SHA 불일치');
   const measured=await acquisition.detectPrepared({pixels,width:input.width,height:input.height,
    binding:{sourceFrameId:link.sourceFrameId,captureTime:link.captureTime}},target);
   try{
    ensure(measured.rasterReceipt.hash===input.sha256&&measured.rasterReceipt.sourceFrameId===link.sourceFrameId&&measured.rasterReceipt.captureTime===link.captureTime,'실제 획득 내부 래스터 근거 불일치');
    history.push({originalAcquisitionFrameId:row.acquisitionFrameId,originalUse:link,newMeasuredReceipt:measured.rasterReceipt,layout:measured.layout,
      cells:measured.cells.length,timing:measured.timing,physicalHeader:row.header});
    if(row.acquisitionFrameId===9||row.acquisitionFrameId===10){
     const cell=measured.cells[5];ensure(cell?.slot===5,'실제 6번째 카드 없음');const visual=inspectVisual(cell.image,context as RasterContext,templates),
      normalizedBytes=rgba(normalized).slice(),packed=packCount(normalizedBytes,140,visual.offsetY),value=readVisual(cell.image,context as RasterContext,visual,patterns),
      offset=visual.offsetY;
     const regions=await Promise.all([region(normalizedBytes,'counter-union',54,138+offset,86,34),region(normalizedBytes,'icon-core',64,143+offset,18,10),
      region(normalizedBytes,'numeric',90,144+offset,48,20),region(normalizedBytes,'guard-and-counter',50,134+offset,90,40),
      region(normalizedBytes,'jewels',16,172+offset,110,31),region(normalizedBytes,'whole-normalized-card',0,0,140,210)]);
     const report={originalAcquisitionFrameId:row.acquisitionFrameId,sourceUse:link,sourceRgba:input,newMeasuredReceipt:measured.rasterReceipt,
      physicalHeader:row.header,crop:{slot:cell.slot,content:cell.content,preview:cell.preview,alignment:cell.alignment,intact:cell.intact,borderSides:cell.borderSides,
       width:cell.image.width,height:cell.image.height,sha256:await pixelHash(rgba(cell.image))},visual,value,
      normalized:{width:140,height:210,sha256:await pixelHash(normalizedBytes),rgbaBase64:base64(normalizedBytes)},
      counter:{hasIcon:packed.hasIcon,whitePixels:packed.pixels},regions:regions.map(({bytes:_bytes,...rest})=>rest)};
     fields.push({originalAcquisitionFrameId:row.acquisitionFrameId,regions,report});
     const preview=document.createElement('canvas');preview.width=140;preview.height=210;preview.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(normalizedBytes.buffer),140,210),0,0);
     preview.title=`실제 사용 ${row.acquisitionFrameId}`;images.append(preview);
    }
   }finally{for(const cell of measured.cells){cell.image.width=0;if(cell.previewImage)cell.previewImage.width=0;}}
   status.textContent=`실제 획득 ${history.length}/10 · 입력·내부 래스터 해시 일치`;
  }
  ensure(fields.length===2,'대상 카드 픽셀 수집 실패');const comparisons=fields[0].regions.map((value,index)=>compare(value,fields[1].regions[index]));
  sourceEnd=await snapshot(signal);ensure((sourceStart as {sourceDigest:string}).sourceDigest===(sourceEnd as {sourceDigest:string}).sourceDigest,'검사 중 실행 소스 변경');
  const firstVisual=fields[0].report.visual as {awakening:number;offsetY:number},secondVisual=fields[1].report.visual as {awakening:number;offsetY:number};
  const exactCounterReuse=firstVisual.awakening===secondVisual.awakening&&firstVisual.offsetY===secondVisual.offsetY&&
   comparisons.filter(row=>['counter-union','guard-and-counter','jewels'].includes(row.name)).every(row=>row.byteIdentical);
  result.textContent=JSON.stringify({version:1,kind:'ninav-actual-field-roi-proof',complete:true,manifest:{path,sha256:manifestSha,producerSourceDigest:manifest.producerSourceDigest,
   original:manifest.original,retained:manifest.retained},sourceStart,sourceEnd,history,fields:fields.map(field=>field.report),comparisons,
   unavailable:manifest.targets.filter(row=>!row.available),conclusion:{byteIdenticalCounterReuseFeasible:!!exactCounterReuse,
    acceptanceChanged:false,humanExpected:null},elapsedMs:performance.now()-started,
   boundaries:{actualAcquisitionWorker:true,allInputInternalRasterHashesVerified:true,primer:'first 10 explicit uses in original use order',nearestTimestampUsed:false,
    fullRecordingComplete:false,wholeFileBrowserFetch:false,maximumFullInputFetchBytes:Math.max(...ordered.map(row=>row.restored!.bytes)),
    fullMemoryMeasured:false,recognizerOrThresholdChanged:false}},null,2);
  status.textContent=exactCounterReuse?'실제 필드가 바이트 단위로 동일합니다.':'실제 필드가 서로 다릅니다 · 기존 미확정 값 유지';
 }catch(error){status.textContent=String(error);result.textContent=JSON.stringify({version:1,kind:'ninav-actual-field-roi-proof',complete:false,error:String(error),
  sourceStart,sourceEnd,history,fields:fields.map(field=>field.report),elapsedMs:performance.now()-started},null,2);}
 finally{acquisition.dispose();target.width=target.height=normalized.width=normalized.height=0;active=undefined;button.disabled=false;}
});
