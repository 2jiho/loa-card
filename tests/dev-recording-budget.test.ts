import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingBudget} from '../dev/recording-budget';
test('development budget cannot enlarge production limits and isolates capacity experiments',()=>{
 assert.deepEqual(recordingBudget(null),{bytes:536870912,database:'loacard-reproduction-dev'});
 assert.equal(recordingBudget('450').bytes,471859200);
 assert.notEqual(recordingBudget('450').database,recordingBudget(null).database);
 for(const value of ['','0','31','513','450.5','0450',' 450','Infinity','1e2'])assert.throws(()=>recordingBudget(value));
});
