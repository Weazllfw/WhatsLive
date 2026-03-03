import { useEffect, useRef, useState, useCallback } from 'react';
import type { WsEnvelope } from '../types';

type MessageHandler = (env: WsEnvelope) => void;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

export function useWebSocket(onMessage: MessageHandler) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const retryDelay = useRef(BASE_DELAY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      retryDelay.current = BASE_DELAY;
    };

    ws.onmessage = (event) => {
      try {
        const env = JSON.parse(event.data) as WsEnvelope;
        onMessageRef.current(env);
      } catch {
        console.warn('ws: unparseable message', event.data);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      timerRef.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, MAX_DELAY);
        connect();
      }, retryDelay.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status };
}
