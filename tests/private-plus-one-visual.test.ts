import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Private opt-in regression. The three +1 labels are assistant visual review
// of crops from one recording, not user labels or independent sessions. The
// verifier checks the original Blob, source frame, acquisition geometry and
// PNG pixels; it does not attest the historical reader canvas or full OCR.
const manifest=process.env.LOACARD_ASSISTANT_PLUS_ONE_CASE;
const expected='6d8ed4c693157dfa9d1c363c1e518f29f43bd4fa9bae7cc528a78620e0bad0f4';
test('optional private assistant-reviewed +1 crops stay +1 or unknown',
  {skip:!manifest,timeout:180_000},()=>{
    const run=spawnSync(process.execPath,['--import','tsx','work/verify-assistant-plus-one-20261104.mjs',manifest!],
      {encoding:'utf8',timeout:175_000,maxBuffer:1024*1024});
    assert.equal(run.status,0,run.stderr||'private verifier failed');
    const report=JSON.parse(run.stdout);
    assert.equal(report.manifestSha256,expected);
    assert.equal(report.labelSource,'assistant-visual-review');
    assert.equal(report.readerCanvasVerified,false);
    assert.equal(report.originalCaptureComplete,'unknown');
    assert.equal(report.independentSessionCount,1);
    assert.deepEqual(report.cases.map((row:{id:string})=>row.id),['3201105','3201031','3201008']);
    for(const row of report.cases){
      assert.equal(row.expectedAdditionalCopies,1);
      assert.ok(row.actualAdditionalCopies===1||row.actualAdditionalCopies===null,
        `${row.name}: ${row.actualAdditionalCopies} is not safe for a +1 case`);
      if(row.actualAdditionalCopies===null)assert.equal(row.reliability,'unconfirmed');
    }
  });
