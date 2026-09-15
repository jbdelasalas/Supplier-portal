import Image from 'next/image';

/**
 * The company mark.
 *
 * Looks for /logo.svg then /logo.png at build time via NEXT_PUBLIC_LOGO_URL,
 * and falls back to a wordmark when no file is present — so the portal never
 * renders a broken image, and dropping a logo into /public is the only step
 * needed to brand it.
 */

const LOGO_SRC = process.env.NEXT_PUBLIC_LOGO_URL ?? '/logo.png';
const COMPANY = process.env.NEXT_PUBLIC_APP_NAME ?? 'Artfresh';
const HAS_LOGO = process.env.NEXT_PUBLIC_HAS_LOGO === 'true';

// The Art Fresh badge is a tall oval (850 x 1190, roughly 5:7), not a wide
// wordmark. Width is derived from that ratio so the mark keeps its proportions
// wherever it appears, and callers size it by height alone.
const LOGO_ASPECT = 850 / 1190;

interface Props {
  /** Rendered height in px; width follows the logo's aspect ratio. */
  height?: number;
  /** Show the company name beside the mark. */
  showName?: boolean;
  className?: string;
}

export default function Logo({ height = 32, showName = false, className = '' }: Props) {
  if (!HAS_LOGO) {
    return <Wordmark height={height} className={className} />;
  }

  const width = Math.round(height * LOGO_ASPECT);

  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <Image
        src={LOGO_SRC}
        alt={COMPANY}
        // Request double the rendered size so the badge stays crisp on
        // retina displays, where 1 CSS px is 2 device px.
        height={height * 2}
        width={width * 2}
        quality={90}
        priority
        className="object-contain"
        style={{ height, width }}
      />
      {showName && (
        <span className="text-lg font-semibold tracking-tight text-slate-900">{COMPANY}</span>
      )}
    </span>
  );
}

/**
 * Typographic fallback. Deliberately plain — a placeholder that looks like a
 * placeholder is better than one mistaken for the real brand.
 */
function Wordmark({ height, className }: { height: number; className: string }) {
  return (
    <span
      className={`inline-flex items-center font-semibold tracking-tight text-slate-900 ${className}`}
      style={{ fontSize: Math.round(height * 0.6), lineHeight: 1 }}
    >
      <span
        className="mr-2 inline-flex items-center justify-center rounded-md bg-brand-600 font-bold text-white"
        style={{ height, width: height, fontSize: Math.round(height * 0.5) }}
        aria-hidden="true"
      >
        {COMPANY.charAt(0).toUpperCase()}
      </span>
      {COMPANY}
    </span>
  );
}
