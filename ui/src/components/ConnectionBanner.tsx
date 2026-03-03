import type { ConnectionStatus } from '../hooks/useWebSocket';

interface Props {
  status: ConnectionStatus;
}

export function ConnectionBanner({ status }: Props) {
  if (status === 'connected') return null;

  return (
    <div className={`connection-banner connection-banner--${status}`}>
      {status === 'connecting' ? 'Connecting to WhatsLive…' : 'Disconnected — reconnecting…'}
    </div>
  );
}
