import {Component, lazy, Suspense, useState} from 'react';
import type {ComponentType, ReactNode} from 'react';
import Button from '@mui/material/Button';

class PanelFailure extends Component<{children:ReactNode;retry:()=>void},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed
    ? <div className="notice" role="alert">화면을 불러오지 못했습니다. 카드 목록과 스캔은 유지됩니다. <Button onClick={this.props.retry}>다시 시도</Button></div>
    : this.props.children;}
}

/** Feature loading/failure never unmounts the capture video or inventory. */
export function deferredPanel<P extends object>(load:()=>Promise<{default:ComponentType<P>}>) {
  return function DeferredPanel(props:P) {
    const [panel,setPanel]=useState(()=>({component:lazy(load),revision:0}));
    const View=panel.component;
    return <PanelFailure key={panel.revision} retry={()=>setPanel(previous=>({component:lazy(load),revision:previous.revision+1}))}>
      <Suspense fallback={<p role="status" className="muted"><span className="scan-spinner" aria-hidden="true"/> 화면을 불러오는 중…</p>}>
        <View {...props}/>
      </Suspense>
    </PanelFailure>;
  };
}
