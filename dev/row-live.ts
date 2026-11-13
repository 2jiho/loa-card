import {prepareRecordedShareInput} from './recorded-share-input';
import {runRowScan} from '../src/features/card-scanner/orchestration/row-scan';
import type {RowLiveResult} from '../src/features/card-scanner/orchestration/row-scan';

export type {RowLiveResult} from '../src/features/card-scanner/orchestration/row-scan';

/** The row-centred scan (src/features/card-scanner/orchestration/row-scan.ts) on a recording,
 * or on a live input the caller prepared. */
export async function runRowLive(options:Omit<Parameters<typeof runRowScan>[0],'input'>&{
  /** The recording to replay; or `input` for a live share. */recordingId?:string;
  input?:Parameters<typeof runRowScan>[0]['input']}):Promise<RowLiveResult> {
  const {recordingId,input,...rest}=options;
  if(!input&&!recordingId)throw Error('기록 또는 실시간 입력이 필요합니다.');
  return runRowScan({...rest,input:input??await prepareRecordedShareInput({recordingId:recordingId!,target:options.target,signal:options.signal})});
}
