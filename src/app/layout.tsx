import type { Metadata, Viewport } from 'next';
import { Outfit } from 'next/font/google';
import './globals.css';

// Matches the ERP's typography exactly (apps/web/src/app/layout.tsx), so the
// two systems read as one product to staff who move between them.
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-outfit',
  display: 'swap',
});

const COMPANY = process.env.NEXT_PUBLIC_APP_NAME ?? 'Art Fresh';

export const viewport: Viewport = {
  // The brand red, sampled from the logo — tints the browser chrome on mobile.
  themeColor: '#f01010',
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: {
    default: `${COMPANY} Supplier Portal`,
    template: `%s · ${COMPANY}`,
  },
  description: `Apply for a supplier account with ${COMPANY}, place orders, and track deliveries.`,
  // Falls back to Next's default when no icon file is present, rather than
  // rendering a broken one.
  icons: process.env.NEXT_PUBLIC_HAS_LOGO === 'true'
    ? { icon: '/favicon.png', apple: '/favicon.png' }
    : undefined,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className={outfit.className}>{children}</body>
    </html>
  );
}
