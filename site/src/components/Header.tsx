'use client';
import Link from 'next/link';

const TelegramIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.665 3.717l-17.73 6.837c-1.21.486-1.203 1.161-.222 1.462l4.552 1.42 10.532-6.645c.498-.303.953-.14.579.192l-8.533 7.701h-.002l.002.001-.314 4.692c.46 0 .663-.211.921-.46l2.211-2.15 4.599 3.397c.848.467 1.457.227 1.668-.787l3.019-14.228c.309-1.239-.473-1.8-1.282-1.434z" />
  </svg>
);

export default function Header() {
  return (
    <nav className="fixed top-0 left-0 w-full z-50 glass-panel border-b-subtle">
      <div className="max-w-7xl mx-auto px-6 md:px-12 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <img src="/enact_without.png" alt="ENACT" className="h-10 w-10" />
          <span className="font-serif italic text-xl tracking-tight text-white">
            ENACT<span className="font-sans not-italic font-light text-sm text-gray-400 ml-2 relative -top-0.5">Protocol</span>
          </span>
        </Link>
        <div className="hidden md:flex items-center space-x-8">
          <a href="/#mechanism" className="mono-label text-gray-400 hover:text-white transition-colors">Protocol</a>
          <a href="/#specification" className="mono-label text-gray-400 hover:text-white transition-colors">Specification</a>
          <a href="/#architecture" className="mono-label text-gray-400 hover:text-white transition-colors">Architecture</a>
          <a href="/#ecosystem" className="mono-label text-gray-400 hover:text-white transition-colors">Ecosystem</a>
          <Link href="/docs/getting-started" className="mono-label text-gray-400 hover:text-white transition-colors">Docs</Link>
        </div>
        <div className="hidden md:flex items-center gap-5">
          <a href="https://t.me/EnactProtocolBot" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:opacity-70 transition-opacity" title="Telegram Bot">
            <TelegramIcon />
          </a>
          <a href="https://github.com/enact-protocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-white hover:bg-white/5 transition-all">
            <i className="hgi-stroke hgi-github mr-2" style={{ fontSize: 16 }} /> GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
