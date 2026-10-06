'use client';

import { useEffect, useState } from 'react';

interface ImageCarouselProps {
  images: string[];
  alt: string;
  intervalMs?: number;
  className?: string;
}

/** Crossfading auto-advance carousel for the landing page's module
 *  screenshots. All images render into the DOM up front (just opacity-0
 *  for whichever aren't active) rather than being swapped in on demand —
 *  that's what makes the fade itself the preload: every image's real <img>
 *  src is already loading/decoded well before its turn comes up, so there
 *  is no blank flash the way a lazy-swapped <img src> would have. */
export function ImageCarousel({ images, alt, intervalMs = 7000, className }: ImageCarouselProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (reducedMotion || paused || images.length <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % images.length), intervalMs);
    return () => clearInterval(timer);
  }, [reducedMotion, paused, images.length, intervalMs]);

  // Reduced motion: the first image only, no fade, no timer, no dots —
  // not just a frozen carousel, an actual static image.
  if (reducedMotion) {
    return (
      <div className={`relative overflow-hidden bg-muted/40 ${className ?? ''}`}>
        <img src={images[0]} alt={alt} className="h-full w-full object-contain" />
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden bg-muted/40 ${className ?? ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {images.map((src, i) => (
        <img
          key={src}
          src={src}
          alt={i === 0 ? alt : ''}
          loading="eager"
          decoding="async"
          // object-contain, not -cover — these are real dashboard
          // screenshots, wider than this box's 16:10 frame; cropping would
          // cut real UI off the sides instead of just letterboxing it.
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ease-in-out ${
            i === index ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ))}
      {images.length > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Show image ${i + 1} of ${images.length}`}
              aria-current={i === index}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i === index ? 'bg-white' : 'bg-white/50 hover:bg-white/75'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
