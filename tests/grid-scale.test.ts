import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitGridScale,gridEdges} from '../src/features/card-scanner/acquisition/grid-scale';
import {DEFAULT_LAYOUT} from '../src/features/card-scanner/acquisition/layout-geometry';

/** A synthetic screen: dark background with the 10x4 grid of bright cards drawn at `scale`. */
function screen(width:number,height:number,originX:number,originY:number,scale:number):Float32Array {
  const gray=new Float32Array(width*height).fill(20);
  for(let row=0;row<DEFAULT_LAYOUT.rows;row++)for(let column=0;column<DEFAULT_LAYOUT.columns;column++){
    const left=originX+(DEFAULT_LAYOUT.gridX+column*DEFAULT_LAYOUT.columnStep)*scale,top=originY+(DEFAULT_LAYOUT.gridY+row*DEFAULT_LAYOUT.rowStep)*scale;
    const right=left+DEFAULT_LAYOUT.cardWidth*scale,bottom=top+DEFAULT_LAYOUT.cardHeight*scale;
    for(let y=Math.max(0,Math.floor(top));y<Math.min(height,Math.ceil(bottom));y++)for(let x=Math.max(0,Math.floor(left));x<Math.min(width,Math.ceil(right));x++){
      // Area coverage at the card's fractional edges, as a renderer would draw it.
      const cover=Math.max(0,Math.min(x+1,right)-Math.max(x,left))*Math.max(0,Math.min(y+1,bottom)-Math.max(y,top));
      gray[y*width+x]=20+cover*180;
    }
  }
  return gray;
}

test('the grid scale is refined from the card edges when the anchor scale is off by 0.009', () => {
  // A 2560x1440 window that does not fit the screen: drawn at 0.979, the anchor says 0.97.
  const width=2510,height=1438,originX=830,originY=24,truth=.979;
  const gray=screen(width,height,originX,originY,truth);
  const fit=fitGridScale({gray,width,height,originX,originY,scale:.97});
  assert.ok(fit);
  assert.ok(Math.abs(fit.scale-truth)<=.001,`fitted ${fit.scale}`);
  assert.ok(fit.gain>1);
  // The last column's right edge is then within a pixel of where the screen has it.
  const fitted=gridEdges(originX,originY,fit.scale).x.at(-1)!,real=gridEdges(originX,originY,truth).x.at(-1)!;
  assert.ok(Math.abs(fitted-real)<1.5,`${fitted} vs ${real}`);
});

test('an exact anchor scale stays as it is', () => {
  const width=2560,height=1440,originX=800,originY=206;
  const fit=fitGridScale({gray:screen(width,height,originX,originY,1),width,height,originX,originY,scale:1});
  assert.ok(fit);
  assert.equal(fit.scale,1);
});

test('nothing is fitted when the grid is not on screen', () => {
  const width=400,height=300;
  assert.equal(fitGridScale({gray:new Float32Array(width*height).fill(20),width,height,originX:5000,originY:5000,scale:1}),null);
});
