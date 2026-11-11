/** The source-scoped lifecycle is an opt-in development experiment only. */
export type UnknownSourcePolicy = 'source-v2';
export function sourceScopedUnknownEnabled(development:boolean,policy:UnknownSourcePolicy|undefined):boolean {
  return development&&policy==='source-v2';
}
/** Refuse ambiguous and misspelled experiment flags instead of silently testing v1. */
export function parseUnknownSourcePolicy(search:string):UnknownSourcePolicy|undefined {
  const options=new URLSearchParams(search).getAll('unknownPolicy');
  if(options.length>1||options.some(value=>value!=='source-v2'))throw Error('미식별 실험은 unknownPolicy=source-v2만 지원합니다.');
  return options.length?'source-v2':undefined;
}
