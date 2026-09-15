/**
 * Browser-side image downscaling for uploads.
 *
 * A phone photo of a business permit is routinely 4-12 MB, while the same
 * page at 1600px wide and JPEG q80 is usually under 500 KB and just as
 * readable. Shrinking before the request saves the applicant's mobile data as
 * well as our storage, so it happens here rather than on the server.
 *
 * Every failure path returns the original file: an unreadable or exotic image
 * must still reach the reviewer. Compression is an optimisation, never a gate.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.8;

/** Below this, re-encoding tends to cost more bytes than it saves. */
const SKIP_UNDER_BYTES = 600 * 1024;

/**
 * PNG screenshots of permits re-encode well as JPEG, but PNGs with
 * transparency would gain a black background, so they are left alone.
 * HEIC is excluded because browsers cannot decode what they cannot render.
 */
const COMPRESSIBLE = new Set(['image/jpeg', 'image/jpg', 'image/webp']);

export interface CompressionResult {
  file: File;
  /** False when the original was returned untouched. */
  compressed: boolean;
  originalSize: number;
}

export async function compressImage(file: File): Promise<CompressionResult> {
  const original = { file, compressed: false as const, originalSize: file.size };

  if (typeof document === 'undefined') return original;
  if (!COMPRESSIBLE.has(file.type.toLowerCase())) return original;
  if (file.size <= SKIP_UNDER_BYTES) return original;

  try {
    const bitmap = await loadBitmap(file);
    if (!bitmap) return original;

    const { width, height } = fit(bitmap.width, bitmap.height, MAX_EDGE);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return original;

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    if ('close' in bitmap) bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    );
    if (!blob) return original;

    // A larger result means the source was already better optimised than
    // anything we would produce. Keep theirs.
    if (blob.size >= file.size) return original;

    return {
      file: new File([blob], renameToJpg(file.name), {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      }),
      compressed: true,
      originalSize: file.size,
    };
  } catch {
    return original;
  }
}

/**
 * createImageBitmap applies EXIF orientation, so a photo taken sideways stays
 * upright. The <img> path is the fallback for browsers that lack it.
 */
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to the <img> decode below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Scale to fit within `max` on the longest edge; never enlarge. */
function fit(w: number, h: number, max: number) {
  const scale = Math.min(1, max / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function renameToJpg(name: string): string {
  return name.replace(/\.[a-z0-9]{1,8}$/i, '') + '.jpg';
}

/** "4.2 MB → 380 KB", for telling the applicant what happened. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
