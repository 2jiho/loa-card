import {test} from 'node:test';import assert from 'node:assert/strict';
import {matchCardName} from '../src/features/card-scanner/card-dictionary';
test('audited complete client aliases resolve to the canonical ID; collisions stay uncertain',()=>{
 const card={id:'promo',name:'도발하는 사샤',rarity:3,aliases:['도발하는 사샤 카드']};
 assert.equal(matchCardName('도발하는 사샤 카드',[card])?.card.id,'promo');
 assert.equal(matchCardName('도발하는 사샤 카드',[card])?.exact,true);
 assert.equal(matchCardName('도발하는',[card]),null);
 assert.equal(matchCardName('도발하는 사샤 카드',[card,{...card,id:'conflict'}]),null);
});
