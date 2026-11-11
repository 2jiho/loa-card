import {createRoot} from 'react-dom/client';
import {CardTile} from '../src/CardTile';
import {CURRENT_FIELD_REVIEW} from '../src/features/card-scanner/session/current-scan-fields';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import '../src/index.css';
import '../src/App.css';

const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')==='light'?'light':'dark';
const base:ScannedCard={id:'synthetic',name:'합성 카드',awakening:2,extraCopies:0,
  review:[],countReliable:true,confidence:1,image:'',time:1,observations:1};
// Synthetic crop with deliberately visible old-looking values; no game image.
const sampleCrop='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="#384252"/><text x="10" y="95" fill="white">+4</text><text x="10" y="112" fill="gold">◆◆</text></svg>');
const scenarios=[
  {title:'확정된 값',card:{...base,id:'confirmed',name:'확정 카드'}},
  {title:'추가 장수 미확정',card:{...base,id:'copies',name:'장수 확인 카드',review:['추가 장수 확인'],countReliable:false}},
  {title:'최신 필드 · 화면',card:{...base,id:'latest',name:'최신 확인 카드',image:sampleCrop,review:[CURRENT_FIELD_REVIEW],countReliable:false}},
  {title:'최신 필드 · 원화',card:{...base,id:'artwork',name:'원화 확인 카드',review:[CURRENT_FIELD_REVIEW],countReliable:false},artwork:'3200001.webp'},
  {title:'이름만 확인 필요',card:{...base,id:'name',name:'이름 확인 카드',review:['이름 확인']}},
];
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:650,margin:'24px auto',padding:12}}>
  <h1>카드 값 표시 검사</h1><p>합성 상태로 제품 카드 타일을 렌더링합니다. 인식 정확도 검사는 아닙니다.</p>
  <div style={{display:'grid',gridTemplateColumns:'repeat(5,minmax(0,1fr))',gap:8}}>
    {scenarios.map(({title,card,artwork})=><section key={card.id} aria-label={title}><h2 style={{fontSize:13}}>{title}</h2><CardTile card={card} rarity={3} artwork={artwork}/></section>)}
  </div>
</main>);
