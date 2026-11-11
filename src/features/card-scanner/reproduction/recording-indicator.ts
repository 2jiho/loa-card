/** Development only. Shows the share recording's state in the browser tab title
 * ("●REC 120/310f | LoaCard ...") so a recording that is not being saved is
 * visible while scanning, not only after (docs/dev-recording.md). Never
 * touches the page itself. */
export interface RecordingIndicatorStats {readonly read:number;readonly recorded:number;readonly dropped:number;readonly failure:string|null}

const PREFIX=/^(●|✓|⚠)REC[^|]*\| /;
const baseTitle=()=>document.title.replace(PREFIX,'');

export function showRecordingIndicator(stats:()=>RecordingIndicatorStats){
  const base=baseTitle();
  const render=(text:string)=>{try{document.title=`${text} | ${base}`;}catch{/* No document. */}};
  render('●REC 대기');
  const timer=setInterval(()=>{
    const s=stats();
    render(s.failure?`⚠REC 실패(${s.failure.slice(0,40)}) ${s.recorded}/${s.read}f`
      :`●REC ${s.recorded}/${s.read}f${s.dropped?` 버림 ${s.dropped}`:''}`);
  },1000);
  return {
    /** The recording ended; `frames` is what the server holds (null: nothing was saved). */
    stop(frames:number|null,note?:string){
      clearInterval(timer);
      render(frames?`✓REC ${frames}f 저장`:`⚠REC 저장된 프레임 없음${note?` (${note.slice(0,50)})`:''}`);
    },
    /** The recorder could not start at all. */
    failed(reason:string){clearInterval(timer);render(`⚠REC 시작 안 됨 (${reason.slice(0,60)})`);},
  };
}
