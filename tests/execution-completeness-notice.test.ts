import {test} from 'node:test';
import React from 'react';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExecutionCompletenessNotice} from '../src/features/card-scanner/ui/ExecutionCompletenessNotice';

test('partial, unknown and declared-complete recordings expose their separate limits',()=>{
 const partial=renderToStaticMarkup(React.createElement(ExecutionCompletenessNotice,{complete:false}));
 const unknown=renderToStaticMarkup(React.createElement(ExecutionCompletenessNotice,{complete:null}));
 assert.match(partial,/부분 기록/);assert.match(unknown,/전체 여부를 확인할 수 없습니다/);
 assert.match(unknown,/전체 일치는 미확인/);
 const complete=renderToStaticMarkup(React.createElement(ExecutionCompletenessNotice,{complete:true}));
 assert.match(complete,/종료된 것으로 표시/);assert.match(complete,/저장되지 않은 화면/);assert.match(complete,/판독 정확도/);
});
