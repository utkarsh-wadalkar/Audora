import { useEffect, useRef, useState, useCallback } from 'react';
import { WS_BASE } from '../api/client';

type ReadyState = 'connecting' | 'open' | 'closing' | 'closed';

interface Options {
  /** Called for every parsed JSON message. */
  onMessage?: (data: any) => void;
  /** Auto-reconnect on close (default true). */
  reconnect?: boolean;
  /** Reconnect delay in ms (default 2000). */
  reconnectDelay?: number;
}

/**
 * Generic WebSocket hook with auto-reconnect.
 *
 * @param path e.g. "/ws/logs", "/ws/progress", "/ws/auth"
 */
export function useWebSocket(path: string, options: Options = {}) {
  const { onMessage, reconnect = true, reconnectDelay = 2000 } = options;
  const [readyState, setReadyState] = useState<ReadyState>('connecting');
  const [lastMessage, setLastMessage] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUser = useRef(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    const ws = new WebSocket(`${WS_BASE}${path}`);
    wsRef.current = ws;
    setReadyState('connecting');

    ws.onopen = () => setReadyState('open');
    ws.onclose = () => {
      setReadyState('closed');
      if (reconnect && !closedByUser.current) {
        timerRef.current = setTimeout(connect, reconnectDelay);
      }
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      let data: any = e.data;
      try {
        data = JSON.parse(e.data);
      } catch {
        // leave as raw string
      }
      setLastMessage(data);
      onMessageRef.current?.(data);
    };
  }, [path, reconnect, reconnectDelay]);

  useEffect(() => {
    closedByUser.current = false;
    connect();
    return () => {
      closedByUser.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: string | object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }, []);

  return { readyState, lastMessage, send };
}
