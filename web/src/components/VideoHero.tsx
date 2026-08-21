'use client';

import { useEffect, useState } from 'react';

// Full-bleed video-with-poster background, shared by the marketing landing
// page and the onboarding split panel (sign-in keeps a still photo per
// design decision — no video there).
//
// - The poster <img> is always in the DOM on first paint; the <video> only
//   mounts after a client-side check, so it can never block or delay render.
// - Below 768px, or with prefers-reduced-motion, the <video> never mounts at
//   all — no video bytes are downloaded on mobile or for motion-sensitive
//   users, just the poster.
// - All five attributes below (muted/autoPlay/loop/playsInline/preload) are
//   required together for iOS Safari to autoplay inline without a tap.
export function VideoHero({
  poster,
  mp4,
  webm,
  className = '',
}: {
  poster: string;
  mp4: string;
  webm: string;
  className?: string;
}) {
  const [canPlayVideo, setCanPlayVideo] = useState(false);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setCanPlayVideo(isDesktop && !reducedMotion);
  }, []);

  // No baked-in `relative` here: Tailwind's utilities for the same CSS
  // property don't reliably override by string/class-attribute order (only
  // by their fixed position in the generated stylesheet), so a hardcoded
  // `relative` fighting a caller's `absolute` (both landing and onboarding
  // pass one) can silently win and leave this whole component in normal
  // document flow instead of overlaid — which is exactly what happened
  // here: the poster/video rendered at their own intrinsic aspect-ratio
  // height, in-flow, tall enough to push into and cover the section below.
  // Every caller must supply its own position utility; `overflow-hidden`
  // alone has no such conflict.
  return (
    <div className={`overflow-hidden ${className}`}>
      {/*
        PLACEHOLDER FOOTAGE — stock video, not real Venturelyx brand
        content. Swap web/public/video/hero-trades.{mp4,webm,poster.jpg}
        (same filenames) for real footage; see public/video/SOURCES.md.
        This component's layout/behavior don't need to change.
      */}
      <img
        src={poster}
        alt=""
        aria-hidden
        loading="eager"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {canPlayVideo && (
        <video
          muted
          autoPlay
          loop
          playsInline
          preload="metadata"
          poster={poster}
          onCanPlay={() => setVideoReady(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
            videoReady ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <source src={webm} type="video/webm" />
          <source src={mp4} type="video/mp4" />
        </video>
      )}
    </div>
  );
}
