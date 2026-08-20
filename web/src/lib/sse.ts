// Server-Sent Events consumer for api/src/lib/ai.ts's streamed routes. Not
// EventSource (that's GET-only and can't send a JSON body) — a manual
// fetch + ReadableStream reader, matching the shape every AI-backed route
// sends: `event: <type>\ndata: <json>\n\n`.
import { API_BASE } from './config';

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

export async function streamSSE(path: string, body: unknown, onEvent: (event: SSEEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    onEvent({ type: 'error', message: 'Could not reach the server.' });
    return;
  }
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: 'The AI service is unavailable right now.' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      let data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;
      try {
        onEvent({ type: eventName, ...JSON.parse(data) });
      } catch {
        // Malformed frame — skip rather than crash the stream.
      }
    }
  }
}
