'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { Star, Plus, CheckCircle } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { Review, ReviewSource } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { AIStreamPanel } from '@/components/AIStreamPanel';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';

const REVIEWS_KEY = '/reviews';
const SOURCES: ReviewSource[] = ['manual', 'google', 'facebook', 'yelp'];

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={14} weight={i <= n ? 'fill' : 'regular'} className={i <= n ? 'text-primary' : 'text-muted-foreground/40'} />
      ))}
    </span>
  );
}

export default function ReviewsPage() {
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const { data: reviews, isLoading, error } = useApi<Review[]>(REVIEWS_KEY);
  const [adding, setAdding] = useState(false);

  const avg = reviews && reviews.length > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const dist = [5, 4, 3, 2, 1].map((n) => ({ n, count: (reviews ?? []).filter((r) => r.rating === n).length }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Reviews &amp; Reputation</p>
          <h1 className="font-display text-3xl font-black tracking-tighter sm:text-4xl">Reviews</h1>
        </div>
        {canEdit && (
          <Button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5">
            <Plus size={16} weight="bold" /> Add review
          </Button>
        )}
      </div>

      {isLoading ? (
        <SkeletonCard />
      ) : error ? (
        <Card className="p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load reviews.'}
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 flex flex-col items-center justify-center border border-border bg-foreground p-6 text-background md:col-span-4">
              <div data-numeric className="font-mono text-5xl font-black tracking-tighter">
                {avg.toFixed(1)}
              </div>
              <Stars n={Math.round(avg)} />
              <p className="mt-2 font-mono text-xs uppercase tracking-[0.2em] text-background/60">
                {reviews?.length ?? 0} review{reviews?.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="col-span-12 flex flex-col justify-center gap-2 border border-border bg-surface p-6 md:col-span-8">
              {dist.map(({ n, count }) => (
                <div key={n} className="flex items-center gap-3">
                  <span className="w-8 font-mono text-xs">{n}★</span>
                  <div className="h-2 flex-1 bg-muted">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${reviews?.length ? (count / reviews.length) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-xs">{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {(!reviews || reviews.length === 0) && (
              <Card className="p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No reviews yet. No review source is connected — add one to get started, or try an AI-drafted reply.
                </p>
              </Card>
            )}
            {reviews?.map((r) => <ReviewCard key={r.id} review={r} canEdit={canEdit} />)}
          </div>
        </>
      )}

      <AddReviewDrawer open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function ReviewCard({ review, canEdit }: { review: Review; canEdit: boolean }) {
  const [draft, setDraft] = useState(review.response_body ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function approve() {
    if (!draft.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch(`/reviews/${review.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ response_body: draft, response_status: 'published' }),
      });
      await mutate(REVIEWS_KEY);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save this reply.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">{review.author_name}</span>
            <Stars n={review.rating} />
            <span className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">{review.source}</span>
          </div>
          {review.body && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{review.body}</p>}
        </div>
        {review.response_status === 'published' && (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-success">
            <CheckCircle size={14} weight="fill" /> Replied
          </span>
        )}
      </div>

      <div className="mt-4">
        <AIStreamPanel
          path="/ai/review-response/stream"
          body={{ reviewId: review.id }}
          title="AI-drafted reply"
          triggerLabel={review.response_body ? 'Regenerate' : 'Draft AI response'}
          onTextChange={setDraft}
        />
      </div>

      {canEdit && draft.trim() && (
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={approve} disabled={saving} variant="primary">
            {saving ? 'Saving…' : 'Approve & mark published'}
          </Button>
          {saveError && <span className="text-sm text-destructive">{saveError}</span>}
        </div>
      )}
    </Card>
  );
}

function AddReviewDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [authorName, setAuthorName] = useState('');
  const [rating, setRating] = useState(5);
  const [source, setSource] = useState<ReviewSource>('manual');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAuthorName('');
    setRating(5);
    setSource('manual');
    setBody('');
    setError(null);
  }

  async function onSave() {
    if (!authorName.trim()) {
      setError('Author is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(REVIEWS_KEY, {
        method: 'POST',
        body: JSON.stringify({ author_name: authorName.trim(), rating, source, body: body.trim() || null }),
      });
      await mutate(REVIEWS_KEY);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this review.');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'min-h-[42px] w-full rounded-none border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary';

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Add review</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-1 flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Author<span className="text-primary">*</span>
            <input autoFocus value={authorName} onChange={(e) => setAuthorName(e.target.value)} className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Rating
              <select value={rating} onChange={(e) => setRating(Number(e.target.value))} className={inputCls}>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n} stars
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Source
              <select value={source} onChange={(e) => setSource(e.target.value as ReviewSource)} className={inputCls}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-1 flex-col gap-1 text-sm text-muted-foreground">
            Review text
            <textarea
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className={`${inputCls} min-h-[120px] resize-none py-2`}
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
