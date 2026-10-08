import {useEffect,useState} from 'react';

export function useMerchantClock() {
  const [now,setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh,15_000);
    window.addEventListener('focus',refresh);
    document.addEventListener('visibilitychange',refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus',refresh);
      document.removeEventListener('visibilitychange',refresh);
    };
  },[]);
  return now;
}
