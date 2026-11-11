/** Reproducible manifest for the fixed-grid artwork reconstruction proof.
 * It records the input video hash, exact settings, sampled frame order/hashes
 * and the accepted card crops. It is diagnostic evidence, not recognition
 * truth or completion authority. */
export interface GridReconstructionInput {
  readonly caseId:string;readonly sha256:string;readonly bytes:number;
  readonly duration:number;readonly width:number;readonly height:number;
}
export interface GridReconstructionEnvironment {
  readonly sourceDigest:string|null;readonly files:number|null;readonly build:string|null;
}
export interface GridReconstructionSettings {
  readonly stepSeconds:number;readonly xs:readonly number[];readonly rowOriginY:number;readonly pitchY:number;
  readonly cardWidth:number;readonly cardHeight:number;readonly matcher:string;
}
export interface GridReconstructionFrame {
  readonly time:number;readonly top:number|null;readonly frameSha256:string;
  readonly probeAccepted:number;readonly accepted:number;
}
export interface GridReconstructionCard {
  readonly id:string;readonly name:string;readonly firstTime:number;readonly slot:number;
  readonly corr:number;readonly margin:number;readonly cropSha256:string|null;
}
export interface GridReconstructionManifest {
  readonly version:1;readonly kind:'grid-video-reconstruction';readonly createdAt:string;
  readonly input:GridReconstructionInput;readonly settings:GridReconstructionSettings;
  readonly environment:GridReconstructionEnvironment;readonly frames:readonly GridReconstructionFrame[];
  readonly union:readonly GridReconstructionCard[];readonly expected:number;readonly missing:number;
}
const SHA=/^[a-f0-9]{64}$/;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
function assertInput(input:Omit<GridReconstructionManifest,'version'|'kind'|'missing'>){
  if(typeof input.createdAt!=='string'||!input.createdAt)throw Error('Invalid createdAt');
  const i=input.input;
  if(!i||!SHA.test(i.caseId)||!SHA.test(i.sha256)||!positive(i.bytes)||!finite(i.duration)||
    !positive(i.width)||!positive(i.height))throw Error('Invalid input');
  const s=input.settings;
  if(!s||!finite(s.stepSeconds)||s.stepSeconds<=0||!Array.isArray(s.xs)||s.xs.length!==10||
    s.xs.some(x=>!finite(x))||!finite(s.rowOriginY)||!finite(s.pitchY)||s.pitchY<=0||!positive(s.cardWidth)||
    !positive(s.cardHeight)||typeof s.matcher!=='string'||!s.matcher)throw Error('Invalid settings');
  const e=input.environment;
  if(!e||!(e.sourceDigest===null||SHA.test(e.sourceDigest))||
    !(e.files===null||count(e.files))||!(e.build===null||typeof e.build==='string'))throw Error('Invalid environment');
  if(!positive(input.expected))throw Error('Invalid expected count');
  if(!Array.isArray(input.frames)||input.frames.some(f=>!f||!finite(f.time)||
    !(f.top===null||finite(f.top))||!SHA.test(f.frameSha256)||!count(f.probeAccepted)||!count(f.accepted)))
    throw Error('Invalid frames');
  if(!Array.isArray(input.union)||input.union.some(c=>!c||typeof c.id!=='string'||!c.id||typeof c.name!=='string'||
    !finite(c.firstTime)||!count(c.slot)||c.slot>=40||!finite(c.corr)||!finite(c.margin)||
    !(c.cropSha256===null||SHA.test(c.cropSha256))))throw Error('Invalid union');
  if(new Set(input.union.map(c=>c.id)).size!==input.union.length)throw Error('Duplicate union card');
}
export function createGridReconstructionManifest(
  input:Omit<GridReconstructionManifest,'version'|'kind'|'missing'>,
):GridReconstructionManifest {
  assertInput(input);
  return Object.freeze({version:1,kind:'grid-video-reconstruction',...input,
    missing:Math.max(0,input.expected-input.union.length)});
}
export function parseGridReconstructionManifest(value:unknown):GridReconstructionManifest {
  if(!value||typeof value!=='object')throw Error('Invalid manifest');
  const candidate=value as Partial<GridReconstructionManifest>;
  if(candidate.version!==1||candidate.kind!=='grid-video-reconstruction')throw Error('Invalid manifest kind');
  const created=createGridReconstructionManifest(candidate as Omit<GridReconstructionManifest,'version'|'kind'|'missing'>);
  if(candidate.missing!==created.missing)throw Error('Invalid missing count');
  return created;
}
