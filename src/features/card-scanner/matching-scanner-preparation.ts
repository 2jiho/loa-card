import {preparedScannerConfiguration,type PreparedScanner} from './scanner-preparation';
import {parseScannerNameConfiguration,sameScannerNameConfiguration,type ScannerNameConfiguration} from './scanner-name-configuration';

/** Only call with an App-owned slot. Unknown handles can be left by HMR;
 * dispose that trusted resource before starting a differently configured reader. */
export async function takeMatchingPreparedScanner(take:()=>PreparedScanner|undefined,
  configuration:ScannerNameConfiguration):Promise<PreparedScanner|undefined> {
  const expected=parseScannerNameConfiguration(configuration);
  const candidate=take();
  if(!candidate)return;
  const actual=preparedScannerConfiguration(candidate);
  if(actual&&sameScannerNameConfiguration(actual,expected))return candidate;
  await candidate.dispose();
}
