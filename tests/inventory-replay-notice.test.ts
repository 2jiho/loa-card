import {test} from 'node:test';
import React from 'react';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {InventoryReplayNotice} from '../src/features/card-scanner/ui/InventoryReplayNotice';
import type {InventoryReplaySummary} from '../src/features/card-scanner/reproduction/inventory-evidence-replay';

const inventory:InventoryReplaySummary={supported:true,cards:1,events:1,hash:'a',expectedHash:'a',matchesCapturedState:true};
const policy=(status:'no-seed'|'not-recorded'|'declared')=>({status,
  declared:status==='declared'?'recorded-name-v1' as const:null,producerAuthenticated:false as const});
const render=(status:'no-seed'|'not-recorded'|'declared',recordingComplete:boolean|null,summary=inventory)=>
  renderToStaticMarkup(React.createElement(InventoryReplayNotice,{inventory:summary,policy:policy(status),recordingComplete}));

test('state replay communicates missing or unauthenticated policy and saved hash scope',()=>{
  assert.match(render('no-seed',true),/시작 상태가 없습니다/);
  assert.match(render('no-seed',false),/시작 상태를 확인할 수 없습니다/);
  assert.match(render('no-seed',null),/시작 상태를 확인할 수 없습니다/);
  const old=render('not-recorded',true);
  assert.match(old,/저장된 상태 해시 일치/);assert.match(old,/당시 병합 규칙 미기록/);
  const current=render('declared',true);
  assert.match(current,/카드 합의 규칙 기록됨/);assert.match(current,/전체 상태 규칙 미기록/);assert.match(current,/실행 코드 미인증/);
  assert.doesNotMatch(current,/원래 카드 근거와 일치/);
  const mismatch=render('declared',true,{...inventory,matchesCapturedState:false});
  assert.match(mismatch,/저장된 상태 해시 불일치/);
  for(const complete of [false,null]){
    const partial=render('declared',complete);
    assert.match(partial,/일치 여부 미확인/);assert.doesNotMatch(partial,/저장된 상태 해시 일치 ·/);
  }
});
