'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { compressImage } from '@/lib/compress-image';

/**
 * Live camera capture with an upload fallback.
 *
 * Prefers the camera because a photo taken now, in place, is worth more for
 * verification than an arbitrary file. But the fallback is not optional: on
 * desktop without a webcam, on a locked-down browser, or when permission is
 * refused, the applicant must still be able to finish their application.
 */

export type Facing = 'user' | 'environment';

interface Props {
  label: string;
  hint?: string;
  /** 'user' = selfie, 'environment' = rear camera for the premises. */
  facing?: Facing;
  disabled?: boolean;
  /** A photo already on file. `url` renders it; null means "saved, no preview". */
  existing?: { url: string | null } | null;
  onCapture: (file: File, meta: CaptureMeta) => Promise<void> | void;
}

export interface CaptureMeta {
  source: 'camera' | 'upload';
  capturedAt: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export default function PhotoCapture({
  label,
  hint,
  facing = 'environment',
  disabled,
  existing,
  onCapture,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [live, setLive] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  // Releasing the camera on unmount matters: otherwise the indicator light
  // stays on and the device stays locked to this tab.
  useEffect(() => stop, [stop]);

  // If this always lands in the NotAllowedError branch in production while
  // working locally, check Permissions-Policy in vercel.json before anything
  // else: `camera=()` is an *empty* allowlist that denies our own origin too,
  // so getUserMedia rejects before the browser ever prompts. It needs
  // `camera=(self)`. Same for `geolocation=()` and the coordinates below.
  async function openCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      setLive(true);
      // The element only exists once `live` is true, so attach on the next tick.
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setError(
        name === 'NotAllowedError'
          ? 'Camera permission was declined. You can upload a photo instead.'
          : name === 'NotFoundError'
            ? 'No camera found on this device. Please upload a photo instead.'
            : 'Could not open the camera. Please upload a photo instead.',
      );
    }
  }

  /** Best-effort location; never blocks the capture. */
  function position(): Promise<GeolocationPosition | null> {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (p: GeolocationPosition | null) => resolve(p);
      navigator.geolocation.getCurrentPosition(
        (p) => done(p),
        () => done(null),
        { timeout: 5000, maximumAge: 60_000 },
      );
    });
  }

  async function shoot() {
    const video = videoRef.current;
    if (!video) return;

    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');

      // A selfie preview is mirrored; un-mirror it so the saved photo reads
      // the right way round.
      if (facing === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0);

      const blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, 'image/jpeg', 0.85),
      );
      if (!blob) throw new Error('Could not read the frame');

      const pos = await position();
      const file = new File([blob], `${facing === 'user' ? 'selfie' : 'premises'}.jpg`, {
        type: 'image/jpeg',
      });

      setPreview(URL.createObjectURL(blob));
      stop();

      await onCapture(file, {
        source: 'camera',
        capturedAt: new Date().toISOString(),
        latitude: pos?.coords.latitude,
        longitude: pos?.coords.longitude,
        accuracy: pos?.coords.accuracy,
      });
    } catch {
      setError('Could not take the photo. Please try again or upload one.');
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(chosen: File) {
    setBusy(true);
    setError(null);
    try {
      // Camera captures are already small (1280x960 q85); a photo picked from
      // the gallery is not, so it gets the same treatment before upload.
      const { file } = await compressImage(chosen);
      setPreview(URL.createObjectURL(file));
      await onCapture(file, { source: 'upload', capturedAt: new Date().toISOString() });
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const done = Boolean(preview || existing);

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-800">{label}</p>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {done && <span className="badge bg-green-100 text-green-700">Captured</span>}
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {live && (
        <div className="mt-3 overflow-hidden rounded-md bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="max-h-72 w-full object-contain"
            style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
          />
        </div>
      )}

      {!live && preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt={label}
          className="mt-3 max-h-72 w-full rounded-md object-contain"
        />
      )}

      {!live && !preview && existing && (
        existing.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={existing.url}
            alt={label}
            className="mt-3 max-h-72 w-full rounded-md object-contain"
          />
        ) : (
          <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Photo on file.
          </p>
        )
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!live && (
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={openCamera}
            disabled={disabled || busy}
          >
            {done ? 'Retake' : 'Open camera'}
          </button>
        )}

        {live && (
          <>
            <button type="button" className="btn-primary text-sm" onClick={shoot} disabled={busy}>
              {busy ? 'Saving…' : 'Take photo'}
            </button>
            <button type="button" className="btn-secondary text-sm" onClick={stop} disabled={busy}>
              Cancel
            </button>
          </>
        )}

        {!live && (
          <label className="btn-secondary cursor-pointer text-sm">
            Upload instead
            <input
              type="file"
              accept="image/*"
              // On a phone this opens the camera directly.
              capture={facing}
              className="hidden"
              disabled={disabled || busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) chooseFile(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}
