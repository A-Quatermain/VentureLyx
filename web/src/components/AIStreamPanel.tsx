'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleNotch, Sparkle } from '@phosphor-icons/react';
import { streamSSE } from '@/lib/sse';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

type Status = 'idle' | 'streaming' | 'done' | 'error';

interface Meta {
  provider: string;
  model: string;
  fallback: boolean;
}

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'ChatGPT' };

// Reusable AI streaming panel, styled per design_guidelines.json's AI
// components rule: the brand blue-to-teal gradient is reserved for the
// "Fix this for me"-style CTA (Button's `ai` variant) — the panel chrome
// itself stays a plain white card, like every other surface.
export function AIStreamPanel({
  path,
  body,
  title = 'AI Insight',
  autoStart = false,
  triggerLabel = 'Generate',
  onTextChange,
}: {
  path: string;
  body?: unknown;
  title?: string;
  autoStart?: boolean;
  triggerLabel?: string;
  /** Mirrors the accumulated streamed text out, e.g. so a caller can offer a Save action on it. */
  onTextChange?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const started = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  async function run() {
    setText('');
    onTextChange?.('');
    setError('');
    setMeta(null);
    setStatus('streaming');
    let sawError = false;
    let acc = '';
    await streamSSE(path, body, (event) => {
      if (event.type === 'meta') {
        setMeta({ provider: String(event.provider), model: String(event.model), fallback: !!event.fallback });
      } else if (event.type === 'delta') {
        acc += String(event.text ?? '');
        setText(acc);
        onTextChange?.(acc);
      } else if (event.type === 'error') {
        sawError = true;
        setError(typeof event.message === 'string' ? event.message : 'Something went wrong.');
        setStatus('error');
      }
    });
    if (!sawError) setStatus('done');
  }

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [text]);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkle size={15} weight="fill" className="text-primary" /> {title}
        </span>
        {meta && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
            {PROVIDER_LABEL[meta.provider] ?? meta.provider}
            {meta.fallback ? ' · fallback' : ''} · {meta.model}
          </span>
        )}
      </div>
      <div
        ref={boxRef}
        className="min-h-[100px] max-h-[420px] overflow-y-auto whitespace-pre-wrap p-4 text-sm leading-relaxed"
      >
        {status === 'idle' && <span className="text-muted-foreground">Ready. Click &ldquo;{triggerLabel}&rdquo;.</span>}
        {error && <span className="text-destructive">{error}</span>}
        {text}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <Button variant="ai" onClick={run} disabled={status === 'streaming'} className="inline-flex items-center gap-1.5">
          {status === 'streaming' && <CircleNotch size={14} weight="bold" className="animate-spin" />}
          {status === 'streaming' ? 'Generating…' : text ? 'Regenerate' : triggerLabel}
        </Button>
      </div>
    </Card>
  );
}
