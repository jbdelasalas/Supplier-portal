import Link from 'next/link';
import Logo from '@/components/Logo';
import VideoBackground from '@/components/VideoBackground';

// Set NEXT_PUBLIC_HERO_VIDEO to a path under /public (e.g. "/hero.mp4") to
// turn the background on. Without it the page keeps its plain light styling,
// so a missing file can never leave the landing page unreadable.
const HERO_VIDEO = process.env.NEXT_PUBLIC_HERO_VIDEO;
const HERO_POSTER = process.env.NEXT_PUBLIC_HERO_POSTER;

const FEATURES = [
  {
    title: 'Get accredited online',
    body: 'Fill in the accreditation form, upload your permits, and track the review.',
  },
  {
    title: 'Acknowledge purchase orders',
    body: 'See every order we issue you and confirm the delivery date you can meet.',
  },
  {
    title: 'Track your invoices',
    body: 'Submit an invoice against a purchase order and follow it through to payment.',
  },
];

export default function HomePage() {
  const onVideo = Boolean(HERO_VIDEO);

  const content = (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-16">
      <div className="w-full text-center">
        <div className="mb-8 flex justify-center">
          <Logo height={160} />
        </div>

        <h1
          className={`text-4xl font-bold tracking-tight sm:text-5xl ${
            onVideo ? 'text-white drop-shadow-lg' : 'text-slate-900'
          }`}
        >
          Grow With Us as a Supplier
        </h1>
        <p
          className={`mt-3 text-xl font-medium sm:text-2xl ${
            onVideo ? 'text-accent-300 drop-shadow' : 'text-brand-600'
          }`}
        >
          Apply for accreditation today.
        </p>
        <p
          className={`mx-auto mt-6 max-w-2xl text-lg leading-relaxed ${
            onVideo ? 'text-white/90 drop-shadow' : 'text-slate-600'
          }`}
        >
          Whether you supply feeds, veterinary products, packaging, equipment, or
          hauling and services, we&rsquo;re looking for partners who deliver on time and
          to standard. Get accredited to receive purchase orders, submit your price
          list, and track every invoice through to payment.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/register" className="btn-primary px-6 py-2.5">
            Apply for accreditation
          </Link>
          <Link
            href="/login"
            className={
              onVideo
                ? 'btn border border-white/70 bg-white/10 px-6 py-2.5 text-white backdrop-blur hover:bg-white/20'
                : 'btn-secondary px-6 py-2.5'
            }
          >
            Sign in
          </Link>
        </div>
      </div>

      <div className="mt-16 grid w-full gap-6 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className={
              onVideo
                ? 'rounded-lg border border-white/20 bg-white/10 p-6 text-left backdrop-blur-md'
                : 'card p-6 text-left'
            }
          >
            <h2 className={onVideo ? 'font-semibold text-white' : 'font-semibold text-slate-900'}>
              {f.title}
            </h2>
            <p className={`mt-2 text-sm ${onVideo ? 'text-white/80' : 'text-slate-600'}`}>
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </main>
  );

  if (!onVideo) return content;

  return (
    <VideoBackground src={HERO_VIDEO!} poster={HERO_POSTER}>
      {content}
    </VideoBackground>
  );
}
