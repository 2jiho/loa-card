import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import HelpOutline from '@mui/icons-material/HelpOutlined';
import './UsageGuide.css';

const steps = [
  { title: '성장 탭 열기', text: '게임에서 카드 보관함 → 성장 탭을 열고 목록의 맨 위로 이동하세요.' },
  { title: '게임 화면 공유', text: '화면 공유 시작을 누르고 로스트아크 창을 선택하세요. 스캔 준비가 끝날 때까지 기다려 주세요.' },
  { title: '스크롤바에서 스크롤', text: '스크롤바 위에서 휠을 돌리거나 스크롤바를 천천히 끌어 끝까지 내려 주세요. 카드 위는 피해 주세요.' },
];

function ScanSteps() {
  return <ol className="scan-guide-steps">{steps.map(step => <li key={step.title}><strong>{step.title}</strong><p>{step.text}</p></li>)}</ol>;
}

export function ScanQuickStart({ onHelp }: { onHelp: () => void }) {
  return <section className="scan-quick-start" aria-labelledby="scan-guide-heading">
    <div className="scan-guide-heading"><h2 id="scan-guide-heading">처음이라면 이렇게 시작하세요</h2>
      <Button color="inherit" onClick={onHelp} startIcon={<HelpOutline />}>사용법</Button></div>
    <ScanSteps />
    <p className="scan-guide-footnote">PC의 Chrome·Edge에서 이용하세요. 게임 창이 보이지 않으면 게임이 표시된 화면을 선택하세요.</p>
  </section>;
}

export function UsageGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="usage-guide-title">
    <DialogTitle id="usage-guide-title">LoaCard 사용법</DialogTitle>
    <DialogContent dividers className="usage-guide">
      <section aria-labelledby="guide-scan"><h3 id="guide-scan">카드 스캔</h3>
        <ScanSteps />
        <p>PC의 Chrome·Edge를 사용하세요. 게임 창을 선택할 수 없으면 게임이 표시된 화면을 공유하세요. 카드 이름·보석·장수와 보관함 수량이 가려지지 않게 해 주세요.</p>
        <p>스크롤바에서 조작하면 카드 툴팁이 이름·보석·장수를 가리지 않아 더 잘 읽을 수 있어요. 빠진 구간은 잠깐 멈춰 다시 보여 주세요.</p>
        <p>처음에는 인식 모델을 준비하는 시간이 필요합니다. 화면은 외부 OCR 서버로 전송하지 않고 현재 브라우저에서 읽습니다.</p>
      </section>
      <section aria-labelledby="guide-check"><h3 id="guide-check">스캔이 끝났는지 확인하기</h3>
        <p>전체 카드 이름과 보관함 수량이 확인되면 공유가 자동으로 종료됩니다. 이후에도 <strong>카드를 읽고 있어요</strong>가 보이면 남은 판독이 끝날 때까지 기다려 주세요.</p>
        <dl>
          <dt>수량이 부족하거나 확인할 카드가 남아요</dt><dd>판독이 끝나면 공유를 다시 시작하고 해당 구간을 잠깐 멈춰 보여 주세요. 같은 카드는 중복으로 더하지 않고 갱신합니다.</dd>
          <dt>카드가 잘 안 읽혀요</dt><dd>마우스를 스크롤바로 옮겨 툴팁을 없애고 카드 테두리까지 보이게 해 주세요. 스크롤 속도를 줄여 다시 보여 주세요.</dd>
          <dt>공유 화면이 검게 보여요</dt><dd>공유를 종료하고 게임이 보이는 다른 창이나 화면을 선택하세요.</dd>
        </dl>
      </section>
      <section aria-labelledby="guide-results"><h3 id="guide-results">스캔 다음에는</h3>
        <dl>
          <dt>떠돌이 상인</dt><dd>더 모아야 할 카드의 지역과 등장 시간을 확인하세요. 게임 안의 알림은 직접 설정합니다.</dd>
          <dt>도감작</dt><dd>수집 효과를 선택하면 성장 효율 순서를 계산합니다. 게임에서 실제로 성장시킨 뒤 성장 완료를 눌러 목록에 반영하세요.</dd>
          <dt>레이드 카드</dt><dd>현재 각성과 보유 카드로 성장 가능한 각성을 기준으로 세트를 비교하세요.</dd>
        </dl>
      </section>
      <section aria-labelledby="guide-save"><h3 id="guide-save">목록 보관·다른 계정</h3>
        <p>완료 목록은 같은 주소·브라우저에 자동 저장됩니다. 다른 기기로 옮기거나 별도로 보관하려면 <strong>CSV 저장</strong>을 사용하세요.</p>
        <p>CSV 불러오기는 현재 목록을 교체하며 경험치와 캡처 사진은 포함하지 않습니다. 다른 계정을 스캔할 때는 필요한 CSV를 저장하고 <strong>목록 초기화</strong> 후 시작하세요.</p>
        <p>CSV로 불러온 카드에는 DB에 연결된 원화를 표시합니다. 원화가 없는 카드는 대체 아이콘이 나오며, 이름·각성·장수는 그대로 사용할 수 있습니다.</p>
      </section>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>닫기</Button></DialogActions>
  </Dialog>;
}
