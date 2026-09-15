'use client';

import { useEffect, useState } from 'react';

/**
 * Full-bleed looping video behind the page content.
 *
 * Three things this has to get right, and each is a real failure mode:
 *  - Autoplay only works muted and with playsInline; without the latter, iOS
 *    takes the video fullscreen instead of playing it inline.
 *  - Someone who has asked their OS for reduced motion should get the poster
 *    frame, not a moving picture.
 *  - If the file is missing or the codec unsupported, the poster must remain
 *    rather than leaving a black rectangle.
 */

interface Props {
  /** Path under /public, e.g. "/hero.mp4". */
  src: string;
  /** Still shown before playback and whenever video can't run. */
  poster?: string;
  /** 0-1. Higher darkens more; the default keeps white text legible. */
  overlayOpacity?: number;
  children: React.ReactNode;
}

export default function VideoBackground({
  src,
  poster,
  overlayOpacity = 0.55,
  children,
}: Props) {
  const [canPlay, setCanPlay] = useState(false);
  const [failed, setFailed] = useState(false);
  // Decided before the element mounts, so a reduced-motion visitor never gets
  // a <video> at all rather than one we stop afterwards.
  const [allowMotion, setAllowMotion] = useState(true);

  useEffect(() => {
    setAllowMotion(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  // No manual play() call here on purpose. The element carries `autoPlay`, and
  // calling play() alongside it races the browser's own attempt — the second
  // request aborts the first and logs "The play() request was interrupted by a
  // new load request". Autoplay policy is satisfied by muted + playsInline, and
  // onError below still catches a genuine failure.

  const showVideo = !failed && allowMotion;

  return (
    <div className="relative isolate min-h-screen w-full overflow-hidden">
      {/* Poster sits underneath and shows until the video paints. */}
      {poster && (
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-20 bg-cover bg-center"
          style={{ backgroundImage: `url(${poster})` }}
        />
      )}

      {/* Brand-coloured ground, so a missing poster is never a white flash. */}
      {!poster && (
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-20 bg-gradient-to-br from-brand-700 via-brand-600 to-accent-600"
        />
      )}

      {showVideo && (
        <video
          className={`absolute inset-0 -z-10 h-full w-full object-cover transition-opacity duration-700 ${
            canPlay ? 'opacity-100' : 'opacity-0'
          }`}
          src={src}
          poster={poster}
          autoPlay
          muted
          loop
          playsInline
          // The file is 1.6 MB and loops every 9 seconds, so metadata-only
          // preloading just means it stalls and re-buffers on each pass.
          preload="auto"
          aria-hidden="true"
          disablePictureInPicture
          onCanPlayThrough={() => setCanPlay(true)}
          onError={() => setFailed(true)}
        />
      )}

      {/* Readability layer. Slightly stronger at the top and bottom, where the
          logo and the buttons sit. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-[5] bg-gradient-to-b from-black/70 via-black/40 to-black/70"
        style={{ opacity: overlayOpacity / 0.55 }}
      />

      <div className="relative z-10">{children}</div>
    </div>
  );
}
