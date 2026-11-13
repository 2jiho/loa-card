import type {ListGuidanceMap} from '../session/list-guidance';

const KIND_LABEL={card:'장수·각성 확인 필요',cell:'카드를 알아보지 못한 칸',unseen:'아직 안 본 줄'} as const;

/** The rows to show again and the rows on screen now, on one bar for the whole list, with which
 * way to scroll to the nearest one. Rows are counted from 1 in the text. */
export function ListPositionMap({map}:{map:ListGuidanceMap}){
  const {totalRows,visibleRows,currentRow,targets,direction}=map;
  if(!totalRows||!targets.length)return null;
  const at=(row:number)=>`${row/totalRows*100}%`,span=`max(3px, ${100/totalRows}%)`;
  const screen=currentRow===null?null:{from:currentRow+1,to:Math.min(totalRows,currentRow+visibleRows)};
  const kinds=[...new Set(targets.map(target=>target.kind))];
  const where=direction===null?''
    :direction.kind==='here'?`지금 화면에 다시 볼 줄이 있어요 (${direction.row+1}번째 줄). 잠깐 멈춰 주세요.`
    :`${direction.kind==='up'?'▲ 위쪽':'▼ 아래쪽'} ${direction.row+1}번째 줄을 다시 비춰 주세요`;
  const label=`목록 지도: 다시 볼 줄 ${targets.length}곳${screen?`, 지금 화면 ${screen.from}~${screen.to}번째 줄`:''}${where?`. ${where}`:''}`;
  return <div className="list-map">
    <div className="list-map-bar" role="img" aria-label={label}>
      {targets.map(target=><span key={target.row} className={`list-map-target is-${target.kind}`}
        style={{left:at(target.row),width:span}}/>)}
      {currentRow!==null&&<span className="list-map-screen" style={{left:at(currentRow),width:`max(6px, ${visibleRows/totalRows*100}%)`}}/>}
    </div>
    <div className="list-map-scale" aria-hidden="true"><span>1</span><span>{totalRows}번째 줄</span></div>
    <p className="list-map-direction" aria-live="polite">
      {screen&&<span className="list-map-now">지금 화면 {screen.from}~{screen.to}번째 줄</span>}
      {where&&<strong className={direction?`is-${direction.kind}`:undefined}>{where}</strong>}
    </p>
    <ul className="list-map-legend" aria-hidden="true">
      {kinds.map(kind=><li key={kind}><span className={`list-map-swatch is-${kind}`}/>{KIND_LABEL[kind]}</li>)}
      {currentRow!==null&&<li><span className="list-map-swatch is-screen"/>지금 화면</li>}
    </ul>
  </div>;
}
