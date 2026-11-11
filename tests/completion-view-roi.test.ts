import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completionViewRoi} from '../src/features/card-scanner/session/completion-view-roi';
import type {Layout} from '../src/features/card-scanner/acquisition/detector';

const layout=(scale=1):Layout=>({scale,growthScore:1,score:1,cells:[],
 header:{x:1126*scale,y:198*scale,width:200*scale,height:34*scale},
 growthPoints:{x:1710*scale,y:194*scale,width:230*scale,height:34*scale},
 sort:{x:1718*scale,y:301*scale,width:210*scale,height:40*scale},
 scrollbar:{x:1910*scale,y:386*scale,width:16*scale,height:942*scale},
 area:{x:338*scale,y:386*scale,width:1562*scale,height:942*scale}});
test('ROI covers the growth detector, all grid rows, scrollbar, header and controls without clipping',()=>{
 const actual=completionViewRoi(layout(),2560,1440);
 assert.deepEqual(actual,{x:338,y:124,width:1602,height:1204});
});
test('offscreen, invalid and excessive inputs cannot become a reduced completion proof',()=>{
 const offscreen=layout();offscreen.area.x=-1;
 assert.equal(completionViewRoi(offscreen,2560,1440),null);
 assert.equal(completionViewRoi(layout(2),5120,2880),null);
 assert.equal(completionViewRoi(layout(),NaN,1440),null);
 const invalid=layout();invalid.sort.width=Infinity;
 assert.equal(completionViewRoi(invalid,2560,1440),null);
});
