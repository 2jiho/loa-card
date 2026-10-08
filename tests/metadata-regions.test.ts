import {test} from 'node:test';
import assert from 'node:assert/strict';
import {metadataRegions} from '../src/features/card-scanner/metadata-regions';
import type {Layout} from '../src/features/card-scanner/detector';

test('metadata patches keep the fractional sampling halo and clip only at source bounds',()=>{
 const layout={header:{x:10.25,y:20.75,width:100.5,height:30.1},growthPoints:{x:-4,y:-2,width:14,height:8},sort:{x:98,y:90,width:9,height:12},scrollbar:{x:130,y:1,width:10,height:50}} as Layout;
 assert.deepEqual(metadataRegions(layout,110,100),[
  {x:9,y:19,width:101,height:33},{x:0,y:0,width:11,height:7},{x:97,y:89,width:11,height:11},
 ]);
});
