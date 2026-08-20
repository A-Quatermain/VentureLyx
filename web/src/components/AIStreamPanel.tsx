'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleNotch, Sparkle } from '@phosphor-icons/react';
import { streamSSE } from '@/lib/sse';
import { Button } from '@/components/ui/Button';

type Status = 'idle' | 'streaming' | 'done' | 'error';

interface Meta {
  provider: string;
  model: string;
  fallback: boolean;
}

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'ChatGPT' };

// Reusable AI streaming panel — port of ref-1's AIStreamPanel.jsx onto our
// SSE format (api/src/lib/ai.ts's streamEventsToSSE) and design tokens.
// Not built on ui/Card: Tailwind's color utilities compile in
// theme-key-insertion order (see tone.ts's comment), and `surface` is
// declared after `foreground` in tailwind.config.ts — so Card's baked-in
// bg-surface would always beat a caller's bg-foreground override
// regardless of className order. A plain div sidesteps that entirely.
export function AIStreamPanel({
  path,
  body,
  title = 'AI Insight',
  autoStart = false,
  triggerLabel = 'Generate',
}: {
  path: string;
  body?: unknown;
  title?: string;
  autoStart?: boolean;
  triggerLabel?: string;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const started = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  async function run() {
    setText('');
    setError('');
    setMeta(null);
    setStatus('streaming');
    let sawError = false;
    await streamSSE(path, body, (event) => {
      if (event.type === 'meta') {
        setMeta({ provider: String(event.provider), model: String(event.model), fallback: !!event.fallback });
      } else if (event.type === 'delta') {
        setText((t) => t + String(event.text ?? ''));
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
    <div className="border border-border bg-foreground text-background">
      <div className="flex items-center justify-between border-b border-background/20 px-4 py-2.5">
        <span className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.2em] text-background/70">
          <Sparkle size={13} weight="fill" /> {title}
        </span>
        {meta && (
          <span className="border border-background/30 px-2 py-0.5 font-mono text-[10px]">
            {PROVIDER_LABEL[meta.provider] ?? meta.provider}
            {meta.fallback ? ' · fallback' : ''} · {meta.model}
          </span>
        )}
      </div>
      <div
        ref={boxRef}
        className="min-h-[100px] max-h-[420px] overflow-y-auto whitespace-pre-wrap p-4 text-sm leading-relaxed"
      >
        {status === 'idle' && <span className="text-background/50">Ready. Click &ldquo;{triggerLabel}&rdquo;.</span>}
        {error && <span className="text-destructive">{error}</span>}
        {text}
      </div>
      <div className="flex items-center gap-2 border-t border-background/20 px-4 py-3">
        <Button onClick={run} disabled={status === 'streaming'} className="inline-flex items-center gap-1.5">
          {status === 'streaming' && <CircleNotch size={14} weight="bold" className="animate-spin" />}
          {status === 'streaming' ? 'Generating…' : text ? 'Regenerate' : triggerLabel}
        </Button>
      </div>
    </div>
  );
}
