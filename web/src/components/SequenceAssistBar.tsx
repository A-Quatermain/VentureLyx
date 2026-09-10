'use client';

import { useState } from 'react';
import { Sparkle, X } from '@phosphor-icons/react';
import { streamSSE } from '@/lib/sse';
import type { GrowAssistInstruction } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const INSTRUCTIONS: Array<{ key: GrowAssistInstruction; label: string }> = [
  { key: 'rewrite', label: 'Rewrite' },
  { key: 'shorten', label: 'Shorten' },
  { key: 'tone', label: 'Friendlier tone' },
  { key: 'direct', label: 'More direct' },
];

// Same allowlist the API enforces server-side for full-sequence generation
// (api/src/routes/grow.ts) — this endpoint streams token-by-token, so
// there's no complete string to check until the stream is already done and
// shown to the person; this is the check that runs before "Apply" is
// allowed to splice a bad rewrite into a real step.
const ALLOWED_MERGE_FIELDS = new Set([
  'first_name', 'contact_name', 'entity_name', 'role', 'region', 'city', 'enrollment',
]);

function validateRewrite(text: string): string | null {
  if (text.includes('{{unsubscribe_footer}}')) {
    return 'This rewrite introduced the unsubscribe footer token — discard it and try again.';
  }
  for (const match of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    const name = match[1] ?? '';
    if (!ALLOWED_MERGE_FIELDS.has(name)) {
      return `This rewrite used an unsupported merge field {{${name}}} — discard it and try again.`;
    }
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function SequenceAssistBar({
  selectedText,
  fullValue,
  onApply,
  onClose,
}: {
  selectedText: string;
  fullValue: string;
  onApply: (newText: string) => void;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState<GrowAssistInstruction | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  async function run(instr: GrowAssistInstruction) {
    setInstruction(instr);
    setText('');
    setError('');
    setStatus('streaming');
    let acc = '';
    let sawError = false;
    await streamSSE(
      '/grow/sequence/assist/stream',
      { instruction: instr, text: selectedText, context: fullValue },
      (event) => {
        if (event.type === 'delta') {
          acc += String(event.text ?? '');
          setText(acc);
        } else if (event.type === 'error') {
          sawError = true;
          setError(typeof event.message === 'string' ? event.message : 'Something went wrong.');
          setStatus('error');
        }
      },
    );
    if (!sawError) setStatus('done');
  }

  const validationError = status === 'done' ? validateRewrite(text) : null;

  return (
    <Card className="mt-2 border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkle size={13} weight="fill" className="shrink-0 text-primary" />
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          AI assist on: &ldquo;{truncate(selectedText, 50)}&rdquo;
        </span>
        <div className="ml-auto flex shrink-0 flex-wrap gap-1">
          {INSTRUCTIONS.map((b) => (
            <button
              key={b.key}
              onClick={() => run(b.key)}
              disabled={status === 'streaming'}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                instruction === b.key ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              {b.label}
            </button>
          ))}
          <button onClick={onClose} className="rounded-full p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X size={12} weight="bold" />
          </button>
        </div>
      </div>

      {status !== 'idle' && (
        <div className="mt-2 rounded-lg border border-border bg-background p-2.5 text-sm">
          {status === 'streaming' && !text && <span className="text-muted-foreground">Thinking…</span>}
          <span className="whitespace-pre-wrap">{text}</span>
          {error && <p className="text-destructive">{error}</p>}
        </div>
      )}

      {status === 'done' && (
        validationError ? (
          <p className="mt-1.5 text-xs text-destructive">{validationError}</p>
        ) : (
          <div className="mt-1.5 flex gap-2">
            <Button variant="ghost" onClick={onClose}>Discard</Button>
            <Button onClick={() => onApply(text)}>Apply</Button>
          </div>
        )
      )}
    </Card>
  );
}
