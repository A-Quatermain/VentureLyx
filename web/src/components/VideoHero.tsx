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

  return (
    <div className={`relative overflow-hidden ${className}`}>
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
