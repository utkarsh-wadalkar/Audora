import { isAxiosError } from 'axios';

export function setupConnectionError(error: unknown, retry: string): string | undefined {
  if (!isAxiosError(error)) return;
  if (error.response?.status === 403) {
    return 'Audora’s local service rejected the connection. Quit Audora completely, open the latest build, and try again.';
  }
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return `Audora’s local service took too long to respond. Wait a moment, then select ${retry}.`;
  }
  if (!error.response) {
    return `Audora couldn’t reach its local service. Wait a moment, then select ${retry}. If it still can’t connect, quit and reopen Audora.`;
  }
}
