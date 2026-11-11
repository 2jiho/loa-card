import {lowerPanelCandidate,panelCrossesCardEdge} from '../src/features/card-scanner/acquisition/overlay-quality';

/** Experimental geometry only; status none/unsupported never establishes absence. */
export function obstructionProbeEvidence(frame:Uint8Array,width:number,height:number,
  box:{x:number;y:number;width:number;height:number},pixels:Uint8Array,sides:readonly number[]){
 const lower=lowerPanelCandidate(pixels,box.width,box.height,sides),candidate=lower.candidate;
 return {lower,edges:candidate?{
  left:panelCrossesCardEdge(frame,width,height,box,candidate,'left'),
  right:panelCrossesCardEdge(frame,width,height,box,candidate,'right'),
 }:null};
}
