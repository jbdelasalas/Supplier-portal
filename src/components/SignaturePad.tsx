'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Draw-to-sign canvas.
 *
 * Handles the things that make a signature pad usable on a phone, which is
 * where most of these will be signed:
 *  - Pointer events, so finger, stylus and mouse all work through one path.
 *  - touch-action: none, or the browser scrolls the page instead of drawing.
 *  - Backing store scaled to devicePixelRatio, or strokes look furry on retina.
 *  - Quadratic smoothing between points, so a fast stroke isn't a polygon.
 */

interface Props {
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
  height?: number;
}

export default function SignaturePad({ onChange, disabled, height = 180 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  // Mirrors hasInk in a ref. State updates are async and re-render the
  // component; resizing must not consult a value that lags behind the canvas.
  const inked = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  // Size the backing store to the CSS box times the pixel ratio.
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Resizing clears the canvas, so never do it mid-stroke.
    if (drawing.current) return;

    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    // Preserve any existing ink across a resize.
    const previous = inked.current ? canvas.toDataURL() : null;

    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(height * ratio);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';

    if (previous) {
      const img = new window.Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, height);
      img.src = previous;
    }
  }, [height]);

  useEffect(() => {
    fitCanvas();
    window.addEventListener('resize', fitCanvas);
    return () => window.removeEventListener('resize', fitCanvas);
    // fitCanvas is intentionally omitted: re-running on every ink change would
    // reload the image mid-stroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;

    const p = pointFrom(e);
    last.current = p;

    // Mark the starting point immediately. Without this a tap that never
    // moves — dotting an i, a full stop — leaves no ink at all.
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    inked.current = true;
    if (!hasInk) setHasInk(true);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    const ctx = canvasRef.current?.getContext('2d');
    const from = last.current;
    if (!ctx || !from) return;

    // A pointer can batch several positions into one event. Drawing only the
    // latest skips the ones between, which is what breaks a fast stroke into
    // separate dashes.
    const points = typeof e.nativeEvent.getCoalescedEvents === 'function'
      ? e.nativeEvent.getCoalescedEvents().map((c) => pointFor(c))
      : [pointFrom(e)];
    if (points.length === 0) points.push(pointFrom(e));

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);

    // Curve through each midpoint, using the previous point as the control.
    // The line must END at the point we then remember, or the next segment
    // starts somewhere the ink never reached and leaves a gap.
    let prev = from;
    for (const p of points) {
      const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
      ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      prev = p;
    }
    ctx.lineTo(prev.x, prev.y);
    ctx.stroke();

    last.current = prev;
    inked.current = true;
    if (!hasInk) setHasInk(true);
  }

  /** Canvas-relative point for a raw pointer event from getCoalescedEvents. */
  function pointFor(e: PointerEvent): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    emit();
  }

  function emit() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // isBlank is the authority — hasInk may not have re-rendered yet, and a
    // canvas scanned as empty must never be sent as a signature.
    onChange(isBlank(canvas) ? null : canvas.toDataURL('image/png'));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
    setHasInk(false);
    onChange(null);
  }

  return (
    <div>
      <div
        className={`relative rounded-md border-2 border-dashed bg-white ${
          disabled ? 'border-slate-200 bg-slate-50' : 'border-slate-300'
        }`}
      >
        <canvas
          ref={canvasRef}
          style={{ height, touchAction: 'none' }}
          className={`w-full ${disabled ? 'cursor-not-allowed' : 'cursor-crosshair'}`}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
        />

        {!hasInk && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-slate-400">
              {disabled ? 'Signature locked' : 'Sign here using your finger, stylus or mouse'}
            </p>
          </div>
        )}

        {/* Signing line, the way a paper form has one. */}
        <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-slate-200" />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {hasInk ? 'Signature captured.' : 'Your signature is legally binding.'}
        </p>
        {!disabled && hasInk && (
          <button type="button" onClick={clear} className="text-xs text-brand-600 hover:text-brand-700">
            Clear and sign again
          </button>
        )}
      </div>
    </div>
  );
}

/** True when every pixel is still transparent. */
function isBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}
