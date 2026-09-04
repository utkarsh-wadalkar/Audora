import Link from 'next/link';

export default function NotFound() {
  return <main className="not-found container"><span className="wordmark">Audora.</span><h1>A little off track.</h1><p>This page could not be found.</p><Link href="/" className="button button-primary">Back to Audora</Link></main>;
}
