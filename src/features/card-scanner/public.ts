/** Public surface of the scanner feature. Other features import only this file. */
export {runScanner} from './orchestration/scanner';
export type {ScannerState, UnidentifiedObservation} from './orchestration/scanner';
export type {ScannedCard} from './recognition/recognizer';
export {ScanAttention} from './ui/ScanAttention';
export {ScanMonitor} from './ui/ScanMonitor';
export {ScanReadCount, ScanReadProgress} from './ui/ScanReadProgress';
