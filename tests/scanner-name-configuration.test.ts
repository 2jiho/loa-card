import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NORMAL_SCANNER_NAME_CONFIGURATION,parseScannerNameConfiguration,sameScannerNameConfiguration,
  resolveScannerNameConfiguration,assertScannerNameInputConfiguration} from '../src/features/card-scanner/scanner-name-configuration';

const continued={version:1,rawResultPolicy:'continue'} as const;

test('contrast option is retained, validated and participates in prepared-engine equivalence',()=>{
 const enabled={version:1,rawResultPolicy:'resample',contrastNameFallback:true} as const;
 assert.deepEqual(parseScannerNameConfiguration(enabled),enabled);
 assert.equal(sameScannerNameConfiguration(enabled,NORMAL_SCANNER_NAME_CONFIGURATION),false);
 assert.equal(sameScannerNameConfiguration({...enabled,contrastNameFallback:false},NORMAL_SCANNER_NAME_CONFIGURATION),true);
 assert.deepEqual(resolveScannerNameConfiguration(enabled,'resample',true),enabled);
 assert.throws(()=>assertScannerNameInputConfiguration({...continued,contrastNameFallback:true},{}),/함께/);
 for(const value of [undefined,null,1,'true'])assert.throws(()=>parseScannerNameConfiguration({...enabled,contrastNameFallback:value}),TypeError);
 let reads=0;const accessor={...enabled};Object.defineProperty(accessor,'contrastNameFallback',{enumerable:true,get(){reads++;return true;}});
 assert.throws(()=>parseScannerNameConfiguration(accessor),TypeError);assert.equal(reads,0);
});
test('name configuration is an immutable detached value and the ordinary default remains resample',()=>{
  const input={version:1,rawResultPolicy:'continue'},parsed=parseScannerNameConfiguration(input);
  input.rawResultPolicy='resample';assert.deepEqual(parsed,continued);assert.notEqual(parsed,input);assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(NORMAL_SCANNER_NAME_CONFIGURATION,{version:1,rawResultPolicy:'resample'});assert.ok(Object.isFrozen(NORMAL_SCANNER_NAME_CONFIGURATION));
  assert.deepEqual(parseScannerNameConfiguration(Object.assign(Object.create(null),continued)),continued);
  assert.equal(sameScannerNameConfiguration(continued,parsed),true);
  assert.equal(sameScannerNameConfiguration(continued,NORMAL_SCANNER_NAME_CONFIGURATION),false);
});

test('configuration rejects unsupported shapes and accessor or serializer code without invoking it',()=>{
  let reads=0;
  const getter={...continued};Object.defineProperty(getter,'rawResultPolicy',{enumerable:true,get(){reads++;throw Error('getter');}});
  const hidden={...continued};Object.defineProperty(hidden,'extra',{value:true,enumerable:false});
  const hiddenField={...continued};Object.defineProperty(hiddenField,'rawResultPolicy',{value:'continue',enumerable:false});
  for(const input of [null,undefined,[],{},Object.create(continued),{version:2,rawResultPolicy:'continue'},
    {version:1,rawResultPolicy:'adaptive'},{...continued,provider:'unverified'},getter,hidden,hiddenField,
    {...continued,[Symbol('extra')]:1},{...continued,toJSON(){reads++;throw Error('serializer');}}]){
    assert.throws(()=>parseScannerNameConfiguration(input),TypeError);
    assert.equal(sameScannerNameConfiguration(input,continued),false);assert.equal(reads,0);
  }
});

test('DEV legacy configuration resolves explicitly while production ignores only the legacy flag',()=>{
  for(const development of [true,false])assert.deepEqual(resolveScannerNameConfiguration(undefined,undefined,development),NORMAL_SCANNER_NAME_CONFIGURATION);
  assert.deepEqual(resolveScannerNameConfiguration(undefined,'continue',true),continued);
  assert.deepEqual(resolveScannerNameConfiguration(continued,'continue',true),continued);
  assert.throws(()=>resolveScannerNameConfiguration(continued,'resample',true),/일치/);
  assert.throws(()=>resolveScannerNameConfiguration(undefined,'bad',true),TypeError);
  for(const ignored of ['continue','bad',null,{get rawResultPolicy(){throw Error('must not inspect ignored legacy value');}}])
    assert.deepEqual(resolveScannerNameConfiguration(undefined,ignored,false),NORMAL_SCANNER_NAME_CONFIGURATION);
  assert.deepEqual(resolveScannerNameConfiguration(continued,'resample',false),continued);
  assert.throws(()=>resolveScannerNameConfiguration({version:99},'continue',false),TypeError);
});

test('continuation excludes independent input experiments but does not ban matched prepared or replay input',()=>{
  assert.doesNotThrow(()=>assertScannerNameInputConfiguration(continued,{}));
  const flags=['preparedSource','nativeAcquisition','rgbaRecovery','fractionalPortrait','grayNameFallback','localCropPixels','comparisonInput'] as const;
  for(const flag of flags){
    assert.throws(()=>assertScannerNameInputConfiguration(continued,{[flag]:true}),/함께/);
    assert.doesNotThrow(()=>assertScannerNameInputConfiguration(continued,{[flag]:false}));
    assert.doesNotThrow(()=>assertScannerNameInputConfiguration(NORMAL_SCANNER_NAME_CONFIGURATION,{[flag]:true}));
  }
  for(const minInputIntervalMs of [0,1,100])assert.throws(()=>assertScannerNameInputConfiguration(continued,{minInputIntervalMs}),/함께/);
  assert.doesNotThrow(()=>assertScannerNameInputConfiguration(continued,{minInputIntervalMs:undefined}));
  assert.throws(()=>assertScannerNameInputConfiguration(null,{}),TypeError);
});
