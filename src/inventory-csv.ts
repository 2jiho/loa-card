import type {ScannedCard} from './features/card-scanner/recognizer';
import type {ScannerState} from './features/card-scanner/scanner';

/** Blank means unknown, distinct from an explicitly entered zero. */
export function parseCsvExperience(input:string):number|null {
  const text=input.trim();
  if(!text)return null;
  const value=Number(text.replaceAll(',',''));
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)||!Number.isSafeInteger(value))
    throw new Error('0 이상의 정수를 입력해 주세요. 예: 1,234,567');
  return value;
}

export function csvInventoryState(cards:ScannedCard[],experience:string):ScannerState {
  const current=parseCsvExperience(experience);
  return {status:'CSV 불러오기 완료',percent:100,sampled:0,stable:0,expected:null,capacity:null,cards,
    located:false,unreadable:0,queued:0,droppedFrames:0,unidentified:[],
    growthPoints:current===null?null:{current,maximum:null}};
}

function cell(value: string | number | null) {
  let text=value === null ? '' : String(value);
  // User-edited names must remain text when opened in a spreadsheet.
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text=`'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text;
}
/** Rows represent registered inventory entries, never missing-card references.
 * extraCopies excludes the registered copy and cards spent on awakening. */
export function inventoryCsv(cards:readonly ScannedCard[]):string {
  const rows:[string, string|number|null, string|number|null][]=[['이름','각수','카드수']];
  for(const card of cards)rows.push([card.name,card.awakening,card.extraCopies]);
  return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}

export type CsvCatalogCard={id:string;name:string;rarity:number;maxAwakening?:number;artwork?:string};

function csvRows(source:string):string[][] {
  const rows:string[][]=[];
  let row:string[]=[],field='',quoted=false,closed=false;
  const text=source.replace(/^\uFEFF/,'');
  const finishField=()=>{row.push(field);field='';closed=false;};
  const finishRow=()=>{finishField();if(row.length>1||row.some(value=>value.trim()!==''))rows.push(row);row=[];};
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(quoted) {
      if(char==='"') {if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}
      else field+=char;
    } else if(char===',')finishField();
    else if(char==='\n'||char==='\r') {if(char==='\r'&&text[i+1]==='\n')i++;finishRow();}
    else if(char==='"'&&!field&&!closed)quoted=true;
    else if(char==='"'||closed)throw new Error('CSV 따옴표 형식이 올바르지 않습니다.');
    else field+=char;
  }
  if(quoted)throw new Error('CSV의 닫는 따옴표가 없습니다.');
  if(field||closed||row.length)finishRow();
  return rows;
}

/** Validate the whole file before returning any replacement inventory. */
export function parseInventoryCsv(source:string,catalog:readonly CsvCatalogCard[]):ScannedCard[] {
  if(!catalog.length)throw new Error('카드 DB를 준비한 뒤 다시 불러와 주세요.');
  if(source.length>1_048_576)throw new Error('CSV 파일은 1MB 이내로 선택해 주세요.');
  const [header,...rows]=csvRows(source);
  if(!header||header.map(value=>value.trim()).join(',')!=='이름,각수,카드수'||header.length!==3)
    throw new Error('CSV 첫 줄은 이름,각수,카드수여야 합니다.');
  if(!rows.length)throw new Error('불러올 카드가 없습니다.');
  const normalize=(name:string)=>name.normalize('NFC').trim();
  const byName=new Map(catalog.map(card=>[normalize(card.name),card]));
  const seen=new Set<string>();
  const cards=rows.map((row,index):ScannedCard=>{
    const fail=(message:string):never=>{throw new Error(`${index+2}행: ${message}`);};
    if(row.length!==3)fail('이름, 각수, 카드수 세 칸이 필요합니다.');
    const reference=byName.get(normalize(row[0]));
    if(!reference) return fail(`카드 DB에 없는 이름입니다: ${row[0].slice(0,80)}`);
    if(seen.has(reference.id))fail(`${reference.name} 카드가 중복되어 있습니다.`);
    seen.add(reference.id);
    const number=(value:string,max:number,label:string):number=>{
      const clean=value.trim();
      if(!clean)fail(`${label}가 비어 있습니다. 판독이 완료된 CSV를 선택해 주세요.`);
      if(!/^\d+$/.test(clean)||Number(clean)>max)fail(`${label}는 0~${max} 사이 정수여야 합니다.`);
      return Number(clean);
    };
    const awakening=number(row[1],reference.maxAwakening??5,'각수');
    const extraCopies=number(row[2],reference.maxAwakening===0?0:15,'카드수');
    if(extraCopies>15-awakening*(awakening+1)/2)
      fail(`${reference.name}: 최대 보유량 초과 · ${awakening}각은 추가 ${15-awakening*(awakening+1)/2}장까지 가능합니다.`);
    return {id:reference.id,name:reference.name,awakening,extraCopies,maxAwakening:reference.maxAwakening,
      confidence:1,review:[],
      countReliable:true,image:'',time:0,observations:0};
  });
  return cards.sort((a,b)=>a.name.localeCompare(b.name,'ko'));
}
