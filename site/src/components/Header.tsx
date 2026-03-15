'use client';
import { useState } from 'react';
import Link from 'next/link';

const TelegramIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.665 3.717l-17.73 6.837c-1.21.486-1.203 1.161-.222 1.462l4.552 1.42 10.532-6.645c.498-.303.953-.14.579.192l-8.533 7.701h-.002l.002.001-.314 4.692c.46 0 .663-.211.921-.46l2.211-2.15 4.599 3.397c.848.467 1.457.227 1.668-.787l3.019-14.228c.309-1.239-.473-1.8-1.282-1.434z" />
  </svg>
);

const XIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 w-full z-50 glass-panel border-b-subtle">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-12 h-16 flex items-center justify-between">
        <Link href="/" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-3">
          <img src="/enact_without.png" alt="ENACT" className="h-12 w-12 sm:h-[3.75rem] sm:w-[3.75rem]" />
          <span className="font-serif italic text-lg sm:text-xl tracking-tight text-white">
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
        <div className="hidden md:flex items-center gap-3">
          <a href="https://t.me/EnactProtocolBot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-all">
            <TelegramIcon /> <span className="ml-2">Bot</span>
          </a>
          <a href="https://x.com/EnactProtocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-white hover:bg-white/5 transition-all">
            <XIcon /> <span className="ml-2">X</span>
          </a>
          <a href="https://github.com/ENACT-protocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-white hover:bg-white/5 transition-all">
            <i className="hgi-stroke hgi-github mr-2" style={{ fontSize: 16 }} /> GitHub
          </a>
        </div>
        {/* Mobile hamburger */}
        <button
          className="md:hidden flex flex-col justify-center items-center w-10 h-10 gap-1.5"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          <span className={`block w-5 h-0.5 bg-white transition-all duration-300 ${mobileOpen ? 'rotate-45 translate-y-2' : ''}`} />
          <span className={`block w-5 h-0.5 bg-white transition-all duration-300 ${mobileOpen ? 'opacity-0' : ''}`} />
          <span className={`block w-5 h-0.5 bg-white transition-all duration-300 ${mobileOpen ? '-rotate-45 -translate-y-2' : ''}`} />
        </button>
      </div>
      {/* Mobile menu dropdown */}
      {mobileOpen && (
        <div className="md:hidden glass-panel border-t border-[var(--color-border)] px-4 pb-6 pt-4">
          <div className="flex flex-col space-y-4">
            <a href="/#mechanism" onClick={() => setMobileOpen(false)} className="mono-label text-gray-400 hover:text-white transition-colors py-1">Protocol</a>
            <a href="/#specification" onClick={() => setMobileOpen(false)} className="mono-label text-gray-400 hover:text-white transition-colors py-1">Specification</a>
            <a href="/#architecture" onClick={() => setMobileOpen(false)} className="mono-label text-gray-400 hover:text-white transition-colors py-1">Architecture</a>
            <a href="/#ecosystem" onClick={() => setMobileOpen(false)} className="mono-label text-gray-400 hover:text-white transition-colors py-1">Ecosystem</a>
            <Link href="/docs/getting-started" onClick={() => setMobileOpen(false)} className="mono-label text-gray-400 hover:text-white transition-colors py-1">Docs</Link>
            <div className="border-t border-[var(--color-border)] pt-4 flex items-center gap-3">
              <a href="https://t.me/EnactProtocolBot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-all">
                <TelegramIcon /> <span className="ml-2">Bot</span>
              </a>
              <a href="https://x.com/EnactProtocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-white hover:bg-white/5 transition-all">
                <XIcon /> <span className="ml-2">X</span>
              </a>
              <a href="https://github.com/ENACT-protocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center mono-label px-4 py-2 border-subtle text-white hover:bg-white/5 transition-all">
                <i className="hgi-stroke hgi-github mr-2" style={{ fontSize: 16 }} /> GitHub
              </a>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
