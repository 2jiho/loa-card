import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayBuildLabelNotice,replayVersionNotice} from '../src/features/card-scanner/ui/replay-version-notice';

const a='a'.repeat(64),b='b'.repeat(64);
test('missing or malformed replay signatures are unknown rather than different',()=>{
 for(const missing of [undefined,'', 'old-version',null]){
  assert.match(replayVersionNotice(missing,a,true),/기록 당시의 구성 해시가 없어/);
  assert.doesNotMatch(replayVersionNotice(missing,a,true),/해시가 다릅니다/);
 }
 assert.match(replayVersionNotice(a,undefined,true),/현재 구성 해시를 확인할 수 없습니다/);
});
test('build labels do not establish whether running code versions differ',()=>{
 for(const missing of [undefined,'', '  ',null]){
  assert.match(replayBuildLabelNotice(missing,'abc1234')!,/표기가 없어 비교할 수 없습니다/);
  assert.doesNotMatch(replayBuildLabelNotice(missing,'abc1234')!,/다릅니다/);
  assert.match(replayBuildLabelNotice('abc1234',missing)!,/표기가 없어 비교할 수 없습니다/);
 }
 assert.match(replayBuildLabelNotice('local','local')!,/버전을 확인할 수 없습니다/);
 for(const [recorded,current] of [['local','abc1234'],['abc1234','def5678']]){
  const message=replayBuildLabelNotice(recorded,current)!;
  assert.match(message,/빌드 표기가 다릅니다/);
  assert.doesNotMatch(message,/다른 코드 버전/);
  assert.match(message,/실제 코드 차이는 이 표기만으로 확인할 수 없습니다/);
 }
 assert.equal(replayBuildLabelNotice('abc1234','abc1234'),null);
});
test('replay always uses current code and compares only recorded build boundary hashes',()=>{
 for(const development of [false,true]){
  const equal=replayVersionNotice(a,a,development),different=replayVersionNotice(a,b,development);
  assert.match(equal,/현재 실행 중인 코드로 다시 판독/);
  assert.match(equal,development?/이후 코드가 변경될 수 있어/:/일치를 보장하지는 않습니다/);
  assert.match(different,/구성 해시가 다릅니다/);
  assert.match(different,/현재 실행 중인 코드로 다시 판독/);
 }
});
