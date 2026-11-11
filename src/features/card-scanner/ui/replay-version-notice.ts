/** A build/server-start digest is not a measurement of the modules currently
 * running in a browser. Missing or invalid digests are unknown, not different. */
export function replayVersionNotice(recorded:unknown,current:unknown,development:boolean):string {
 const valid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const prefix='입력은 현재 실행 중인 코드로 다시 판독합니다.';
 if(!valid(recorded))return `${prefix} 기록 당시의 구성 해시가 없어 비교할 수 없습니다.`;
 if(!valid(current))return `${prefix} 현재 구성 해시를 확인할 수 없습니다.`;
 const when=development?'개발 서버 시작 시':'현재 빌드 시';
 if(recorded!==current)return `${prefix} 기록 당시와 ${when} 구성 해시가 다릅니다.`;
 return development
  ?`${prefix} 기록 당시와 개발 서버 시작 시 구성 해시가 같습니다. 이후 코드가 변경될 수 있어 현재 로드된 코드와의 일치는 확인되지 않습니다.`
  :`${prefix} 기록 당시와 현재 빌드 시 구성 해시가 같습니다. 실제 로드된 모든 코드와 데이터의 일치를 보장하지는 않습니다.`;
}

/** Build labels are useful context, not proof of either equality or inequality
 * of the browser's actual loaded code. */
export function replayBuildLabelNotice(recorded:unknown,current:unknown):string|null {
 const known=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
 if(!known(recorded)||!known(current))return '빌드 표기가 없어 비교할 수 없습니다.';
 if(recorded!==current)return '기록과 현재의 빌드 표기가 다릅니다. 실제 코드 차이는 이 표기만으로 확인할 수 없습니다.';
 if(recorded==='local')return '빌드 표기가 local이라 코드 버전을 확인할 수 없습니다.';
 return null;
}
