/** Encodes the small screen picture of a card (session/row-evidence.ts) off the main thread.
 *
 * In: `{id, bitmap}`, the picture already scaled to the card list's tile size (the bitmap is
 * closed here). Out: `{id, url}`, a JPEG data URL, or `{id, url: null}` when it could not be
 * encoded (the card then shows its artwork). */
export interface CardPictureRequest {readonly id:number;readonly bitmap:ImageBitmap}
export interface CardPictureReply {readonly id:number;readonly url:string|null}

const scope=self as unknown as {onmessage:((event:MessageEvent<CardPictureRequest>)=>void)|null;postMessage(message:CardPictureReply):void};

scope.onmessage=event=>{
  const {id,bitmap}=event.data;
  void (async()=>{
    try{
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
      if(!context)throw Error('no 2d context');
      context.drawImage(bitmap,0,0);
      const blob=await canvas.convertToBlob({type:'image/jpeg',quality:.85});
      const url=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>typeof reader.result==='string'?resolve(reader.result):reject(Error('no data URL'));
        reader.onerror=()=>reject(reader.error);
        reader.readAsDataURL(blob);
      });
      scope.postMessage({id,url});
    }catch{scope.postMessage({id,url:null});}
    finally{bitmap.close();}
  })();
};
