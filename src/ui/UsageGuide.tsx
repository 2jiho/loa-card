import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import HelpOutline from '@mui/icons-material/HelpOutlined';
import './UsageGuide.css';

const steps = [
  { title: '성장 탭 열기', text: '게임에서 카드 보관함의 성장 탭을 열어 주세요. 등급은 모든 등급, 분류는 전체로 두고, 검색어를 지우고 "알림 설정 카드만 보기"를 끈 뒤 목록 맨 위로 올려 주세요.' },
  { title: '게임 화면 공유', text: "준비가 끝나면 '화면 공유 시작'을 누르고 로스트아크 창을 골라 주세요." },
  { title: '스크롤바에서 스크롤', text: '마우스를 스크롤바 위에 두고 휠을 돌리거나 스크롤바를 끌어서 목록 끝까지 천천히 내려 주세요. 마우스를 카드 위에 올리면 툴팁이 카드를 가려요.' },
];

function ScanSteps() {
  return <ol className="scan-guide-steps">{steps.map(step => <li key={step.title}><strong>{step.title}</strong><p>{step.text}</p></li>)}</ol>;
}

export function ScanQuickStart({ onHelp }: { onHelp: () => void }) {
  return <section className="scan-quick-start" aria-labelledby="scan-guide-heading">
    <div className="scan-guide-heading"><h2 id="scan-guide-heading">처음이라면 이렇게 시작하세요</h2>
      <Button color="inherit" onClick={onHelp} startIcon={<HelpOutline />}>사용법</Button></div>
    <ScanSteps />
    <p className="scan-guide-footnote">PC의 Chrome이나 Edge에서 써 주세요. 공유할 창 목록에 게임 창이 없으면 게임이 보이는 화면 전체를 골라 주세요. 게임 해상도는 1920×1080 이상을 권장해요.</p>
  </section>;
}

export function UsageGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="usage-guide-title">
    <DialogTitle id="usage-guide-title">LoaCard 사용법</DialogTitle>
    <DialogContent dividers className="usage-guide">
      <section aria-labelledby="guide-scan"><h3 id="guide-scan">카드 스캔</h3>
        <ScanSteps />
        <p>PC의 Chrome이나 Edge에서 써 주세요. 공유할 창 목록에 게임 창이 없으면 게임이 보이는 화면 전체를 공유해 주세요. 카드의 이름·각성·장수와 성장 탭 위쪽의 보관함 수량이 가려지지 않게 해 주세요.</p>
        <p>스크롤바 위에서 넘기면 툴팁이 카드를 가리지 않아 더 잘 읽혀요. 공유 중에 진행 창 지도에 표시된 줄이 있으면 그 줄로 돌아가 잠깐 멈춰 주세요. 스캔 중에 정렬·필터·검색어를 바꿨다면 처음부터 다시 스캔해 주세요.</p>
        <p>페이지를 열면 글자를 읽는 모델을 미리 내려받아 준비해요. 공유한 화면은 다른 서버로 보내지 않고 이 브라우저 안에서만 읽어요.</p>
      </section>
      <section aria-labelledby="guide-check"><h3 id="guide-check">스캔이 끝났는지 확인하기</h3>
        <p>모든 카드의 이름·각성·장수를 읽고 보관함 수량과 맞으면 화면 공유가 자동으로 끝나요. 공유 중에 못 읽은 카드가 있으면 커서와 툴팁을 치우고 그 줄을 다시 보여 주세요. 2분 동안 새로 읽은 카드가 없으면 스캔이 멈춰요.</p>
        <dl>
          <dt>공유가 끝났는데 못 읽은 카드가 남았어요</dt><dd>다시 스캔해 주세요. 새 스캔은 목록을 처음부터 새로 읽기 때문에 처음부터 끝까지 다시 넘겨야 해요. 전에 저장한 목록은 새 스캔이 끝까지 마쳐질 때까지 그대로예요.</dd>
          <dt>카드가 잘 안 읽혀요</dt><dd>마우스를 스크롤바 위로 옮겨 툴팁을 없애고, 카드 테두리까지 화면에 보이게 해 주세요. 스크롤을 더 천천히 해 보세요.</dd>
          <dt>공유 화면이 검게 보여요</dt><dd>공유를 끝내고, 게임이 보이는 다른 창이나 화면 전체를 골라 다시 공유해 주세요.</dd>
        </dl>
      </section>
      <section aria-labelledby="guide-results"><h3 id="guide-results">인식된 카드 활용</h3>
        <p>스캔하는 동안에도 다른 메뉴에 읽은 카드가 바로 반영돼요. 아직 못 읽은 카드는 '미확인'으로 표시돼요. '성장 완료' 버튼은 스캔이 끝난 뒤에 쓸 수 있어요.</p>
        <dl>
          <dt>떠돌이 상인</dt><dd>더 모아야 할 카드를 파는 상인의 지역과 등장 시간을 보여 줘요. 게임 안의 알림은 게임에서 직접 설정해 주세요.</dd>
          <dt>도감작</dt><dd>올리고 싶은 수집 효과를 고르면 어떤 카드부터 성장시키면 좋은지 순서를 계산해요. 게임에서 실제로 성장시킨 뒤 '성장 완료'를 누르면 이 목록에도 반영돼요(게임에는 영향이 없어요).</dd>
          <dt>레이드 카드</dt><dd>지금 각성 단계와, 가진 카드로 올릴 수 있는 각성 단계를 기준으로 세트를 비교해요.</dd>
        </dl>
      </section>
      <section aria-labelledby="guide-save"><h3 id="guide-save">목록 보관·다른 계정</h3>
        <p>스캔을 끝까지 마친 목록은 이 브라우저에 자동으로 저장돼요(같은 주소로 열 때만 보여요). 다른 기기로 옮기거나 따로 보관하려면 <strong>CSV 저장</strong>을 눌러 주세요.</p>
        <p>CSV에는 카드 경험치와 스캔한 화면이 들어 있지 않아요. CSV를 불러올 때 <strong>보유 카드 경험치</strong>를 적으면 도감작 계산에 쓰여요. 비워 두면 경험치는 '미확인'으로 둬요.</p>
        <p>이름·각성·장수를 못 읽은 카드가 있으면 CSV로 저장할 수 없어요. 다시 스캔해 모두 읽은 뒤 저장해 주세요.</p>
        <p>CSV를 불러오면 지금 목록이 CSV의 목록으로 바뀌어요. 다른 계정을 스캔할 때는 지금 목록을 CSV로 저장해 두고 <strong>목록 초기화</strong>를 누른 뒤 시작해 주세요.</p>
        <p>CSV로 불러온 카드에는 기본 카드 그림을 보여 줘요. 그림이 없는 카드는 대신 아이콘이 나오지만 이름·각성·장수는 그대로 쓸 수 있어요.</p>
      </section>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>닫기</Button></DialogActions>
  </Dialog>;
}
