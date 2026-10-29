export interface ScannerNameConfiguration {
  readonly version:1;
  readonly rawResultPolicy:'resample'|'continue';
  readonly contrastNameFallback?:boolean;
}

export const NORMAL_SCANNER_NAME_CONFIGURATION:ScannerNameConfiguration=Object.freeze({version:1,rawResultPolicy:'resample'});

/** Configuration is explicit provenance, never authority supplied by a pool. */
export function parseScannerNameConfiguration(value:unknown):ScannerNameConfiguration {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw TypeError('이름 판독 설정은 일반 객체여야 합니다.');
  const keys=Reflect.ownKeys(value),allowed=['version','rawResultPolicy','contrastNameFallback'];
  if(keys.length<2||keys.length>3||keys.some(key=>typeof key!=='string'||!allowed.includes(key)))
    throw TypeError('이름 판독 설정 필드가 잘못됐습니다.');
  const entries:Record<string,unknown>=Object.create(null);
  for(const key of allowed){
    const property=Object.getOwnPropertyDescriptor(value,key);
    if(key==='contrastNameFallback'&&!property)continue;
    if(!property||!('value' in property)||!property.enumerable)throw TypeError('이름 판독 설정은 고유 데이터 필드가 필요합니다.');
    entries[key]=property.value;
  }
  if(entries.version!==1||(entries.rawResultPolicy!=='resample'&&entries.rawResultPolicy!=='continue'))
    throw TypeError('지원하지 않는 이름 판독 설정입니다.');
  if(Object.hasOwn(entries,'contrastNameFallback')&&typeof entries.contrastNameFallback!=='boolean')
    throw TypeError('대비 이름 보완 설정은 불리언이어야 합니다.');
  return Object.freeze({version:1,rawResultPolicy:entries.rawResultPolicy,
    ...(Object.hasOwn(entries,'contrastNameFallback')?{contrastNameFallback:entries.contrastNameFallback as boolean}:{})});
}

export function sameScannerNameConfiguration(left:unknown,right:unknown):boolean {
  try{const a=parseScannerNameConfiguration(left),b=parseScannerNameConfiguration(right);
    return a.rawResultPolicy===b.rawResultPolicy&&(a.contrastNameFallback===true)===(b.contrastNameFallback===true);}
  catch{return false;}
}

/** Old DEV-only policy flags remain isolated from ordinary production input.
 * An explicit configuration is always validated, including outside DEV. */
export function resolveScannerNameConfiguration(configuration:unknown|undefined,legacyDevPolicy:unknown|undefined,
  development:boolean):ScannerNameConfiguration {
  const explicit=configuration===undefined?undefined:parseScannerNameConfiguration(configuration);
  if(!development||legacyDevPolicy===undefined)return explicit??NORMAL_SCANNER_NAME_CONFIGURATION;
  const legacy=parseScannerNameConfiguration({version:1,rawResultPolicy:legacyDevPolicy});
  if(explicit&&explicit.rawResultPolicy!==legacy.rawResultPolicy)throw TypeError('이름 판독 설정과 개발 옵션이 일치하지 않습니다.');
  return explicit??legacy;
}

export interface ScannerNameInputConfigurationFlags {
  preparedSource?:boolean;nativeAcquisition?:boolean;rgbaRecovery?:boolean;fractionalPortrait?:boolean;
  minInputIntervalMs?:number;inputOfferFloorMs?:number;grayNameFallback?:boolean;localCropPixels?:boolean;comparisonInput?:boolean;
}

/** Matched owned preparation and ordinary replay are allowed. Independent
 * input/preprocessing experiments still require separate validation. */
export function assertScannerNameInputConfiguration(configuration:unknown,flags:ScannerNameInputConfigurationFlags):void {
  const config=parseScannerNameConfiguration(configuration);
  if(config.rawResultPolicy!=='continue')return;
  if(config.contrastNameFallback||flags.preparedSource||flags.nativeAcquisition||flags.rgbaRecovery||flags.fractionalPortrait||
    flags.minInputIntervalMs!==undefined||flags.inputOfferFloorMs!==undefined||flags.grayNameFallback||flags.localCropPixels||flags.comparisonInput)
    throw TypeError('이름 OCR 연속 판독은 다른 입력 실험과 함께 실행하지 않습니다.');
}
