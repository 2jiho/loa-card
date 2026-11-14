import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardTileImage} from '../src/features/card-scanner/acquisition/card-tile-image';
import {CURRENT_FIELD_REVIEW} from '../src/features/card-scanner/session/current-scan-fields';

const latest={name:'카드',image:'data:image/png;base64,abc',review:[CURRENT_FIELD_REVIEW]};
test('an unconfirmed latest field labels the retained screen as a reference',()=>{
 const image=cardTileImage(latest,'/art.webp');
 assert.deepEqual(image,{src:latest.image,label:'이전 화면',alt:'카드 · 이전 화면'});
 assert.deepEqual(latest.review,[CURRENT_FIELD_REVIEW]);
});
test('artwork is a reference image and a missing image is not invented',()=>{
 assert.deepEqual(cardTileImage({...latest,image:''},'/art.webp'),{src:'/art.webp',label:'기본 카드 그림',alt:'카드 · 기본 카드 그림'});
 assert.deepEqual(cardTileImage({...latest,image:''}),{src:'',label:undefined,alt:'카드'});
});
test('confirmed zero and name-only reviews do not imply a latest observation',()=>{
 assert.equal(cardTileImage({...latest,review:[]}).label,undefined);
 assert.equal(cardTileImage({...latest,review:['이름 확인']}).label,undefined);
 assert.equal(cardTileImage({...latest,image:'',review:[]},'/art.webp').alt,'카드');
});
