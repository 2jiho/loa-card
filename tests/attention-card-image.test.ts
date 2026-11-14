import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionCardImage} from '../src/features/card-scanner/ui/attention-card-image';

test('a current failed observation image takes precedence over an older card thumbnail and artwork',()=>{
 assert.deepEqual(attentionCardImage('old','new',true,'art'),{src:'new',label:'최근 화면'});
});
test('a missing current image is explicitly marked while older or artwork references remain identifiable',()=>{
 assert.deepEqual(attentionCardImage('old','',true,'art'),{src:'old',label:'최근 화면 없음 · 참고용'});
 assert.deepEqual(attentionCardImage('','',true,'art'),{src:'art',label:'최근 화면 없음 · 참고용'});
 assert.deepEqual(attentionCardImage('','',true,''),{src:'',label:'최근 화면 없음'});
});
test('images without a current field observation are references, not fabricated latest evidence',()=>{
 assert.deepEqual(attentionCardImage('old','new',false,'art'),{src:'old',label:'참고용'});
 assert.deepEqual(attentionCardImage('','new',false,'art'),{src:'art',label:'참고용'});
 assert.deepEqual(attentionCardImage('','',false,''),{src:'',label:'그림 없음'});
});
