import Link from 'next/link';

const TelegramIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.665 3.717l-17.73 6.837c-1.21.486-1.203 1.161-.222 1.462l4.552 1.42 10.532-6.645c.498-.303.953-.14.579.192l-8.533 7.701h-.002l.002.001-.314 4.692c.46 0 .663-.211.921-.46l2.211-2.15 4.599 3.397c.848.467 1.457.227 1.668-.787l3.019-14.228c.309-1.239-.473-1.8-1.282-1.434z" />
  </svg>
);

export default function Footer() {
  return (
    <footer className="relative overflow-hidden" style={{ background: '#050508' }}>

      {/* ── top: copyright left, links right ── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-12 pt-8 sm:pt-10 pb-6 relative z-10">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <div className="text-xs font-mono text-gray-600">&copy; 2026 ENACT Protocol. All rights reserved.</div>
            <div className="text-xs font-mono mt-1 text-gray-700">Built for TON AI Agent Hackathon 2026</div>
          </div>
          <div className="flex flex-wrap items-center gap-4 sm:gap-5">
            <a href="https://github.com/enact-protocol" target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-white transition-colors">
              <i className="hgi-stroke hgi-github" style={{ fontSize: 18 }} />
            </a>
            <a href="https://t.me/EnactProtocolBot" target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-[var(--color-accent)] transition-colors">
              <TelegramIcon />
            </a>
            <a href="https://tonviewer.com/EQA3t751GuMhAZGnvBm0HOzxrppnz9tLuI__4XXQ_FC7BYcL" target="_blank" rel="noopener noreferrer" className="mono-label text-[10px] text-gray-600 hover:text-white transition-colors">
              Explorer
            </a>
            <Link href="/docs/getting-started" className="mono-label text-[10px] text-gray-600 hover:text-white transition-colors">
              Quick Start
            </Link>
            <Link href="/docs/mcp-server" className="mono-label text-[10px] text-gray-600 hover:text-[var(--color-accent)] transition-colors">
              Connect Agent via MCP
            </Link>
          </div>
        </div>
      </div>

      {/* ── watermark: logo + ENACT, centered, gradient fade ── */}
      <div
        className="relative h-[140px] sm:h-[160px] md:h-[220px] lg:h-[280px] flex items-end justify-center pointer-events-none select-none"
        style={{
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, white 25%, white 70%, transparent 100%)',
          maskImage: 'linear-gradient(to bottom, transparent 0%, white 25%, white 70%, transparent 100%)',
        }}
      >
        <img
          src="/enact_logo.png"
          alt=""
          className="flex-shrink-0"
          style={{
            height: 'clamp(4rem, 14vw, 14rem)',
            width: 'auto',
            opacity: 0.14,
            marginRight: 'clamp(4px, 0.5vw, 10px)',
          }}
          draggable={false}
        />
        <span
          className="font-serif italic leading-[0.82] tracking-tight"
          style={{
            fontSize: 'clamp(3.5rem, 14vw, 14rem)',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.08) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            paddingRight: 'clamp(1.5rem, 4vw, 4rem)',
          }}
        >
          ENACT
        </span>
      </div>
    </footer>
  );
}
