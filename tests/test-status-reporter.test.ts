import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

test('test status distinguishes failures, skipped cases and TODO without changing the runner result',()=>{
  const directory=mkdtempSync(join(tmpdir(),'loa-card-test-status-'));
  try {
    const fixture=join(directory,'fixture.mjs');
    writeFileSync(fixture,`import {test} from 'node:test';
import assert from 'node:assert/strict';
test('passing',()=>{});
test.skip('skipped',()=>{});
test.todo('failed todo',()=>assert.equal(0,1));
test.todo('passing todo',()=>{});
`);
    const reporter=pathToFileURL(resolve('scripts/test-status-reporter.mjs')).href;
    // A nested test runner must not inherit Node's test-child IPC mode.
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,['--test',`--test-reporter=${reporter}`,fixture],{encoding:'utf8',env});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/건너뜀: .*skipped/);
    assert.match(run.stdout,/실패한 TODO: .*failed todo/);
    assert.match(run.stdout,/통과한 TODO \(상태 검토 필요\): .*passing todo/);
    assert.match(run.stdout,/테스트 4개 · 통과 1 · 실패 0 · 건너뜀 1 · TODO 2 · 취소 0/);
    assert.match(run.stdout,/독립적인 인식 정확도나 실제 화면 공유 성능/);
    writeFileSync(fixture,"import {test} from 'node:test'; test('failure',()=>{throw new Error('broken')});\n");
    const failed=spawnSync(process.execPath,['--test',`--test-reporter=${reporter}`,fixture],{encoding:'utf8',env});
    assert.equal(failed.status,1);
    assert.match(failed.stdout,/실패: .*failure/);
    assert.match(failed.stdout,/테스트 1개 · 통과 0 · 실패 1/);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});
