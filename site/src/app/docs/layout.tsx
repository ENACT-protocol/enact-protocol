'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

const sidebar = [
  { group: 'Overview', items: [
    { name: 'What is ENACT', slug: 'what-is-enact' },
    { name: 'Getting Started', slug: 'getting-started' },
  ]},
  { group: 'Smart Contracts', items: [
    { name: 'Job Contract', slug: 'smart-contracts' },
    { name: 'JobFactory', slug: 'job-factory' },
    { name: 'JettonJob', slug: 'jetton-job' },
    { name: 'JettonJobFactory', slug: 'jetton-job-factory' },
  ]},
  { group: 'TypeScript SDK', items: [
    { name: 'Job Wrapper', slug: 'sdk-job' },
    { name: 'JobFactory Wrapper', slug: 'sdk-factory' },
    { name: 'JettonJob Wrapper', slug: 'sdk-jetton' },
  ]},
  { group: 'Integrations', items: [
    { name: 'MCP Server', slug: 'mcp-server' },
    { name: 'Telegram Bot', slug: 'telegram-bot' },
    { name: 'x402 Bridge', slug: 'x402-bridge' },
    { name: 'Teleton Plugin', slug: 'teleton' },
  ]},
  { group: 'Reference', items: [
    { name: 'Environment Variables', slug: 'env-vars' },
    { name: 'Mainnet Deployments', slug: 'mainnet' },
    { name: 'Tech Stack', slug: 'tech-stack' },
  ]},
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar on route change
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Prevent body scroll when mobile sidebar is open
  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="pt-16 flex relative">
        {/* Mobile sidebar toggle */}
        <button
          className="lg:hidden fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-[var(--color-accent)] text-white shadow-lg flex items-center justify-center"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="Toggle docs sidebar"
        >
          {sidebarOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
          )}
        </button>

        {/* Overlay for mobile sidebar */}
        {sidebarOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/60 z-40"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside className={`
          fixed top-16 left-0 w-[280px] h-[calc(100vh-64px)] overflow-y-auto
          border-r border-[var(--color-border)] bg-[#07070A] py-6 pb-24 z-40
          transition-transform duration-300 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:block
        `}>
          {sidebar.map(group => (
            <div key={group.group} className="mb-4">
              <div className="mono-label text-[var(--color-text-dim)] px-6 py-2 text-[0.65rem]">{group.group}</div>
              {group.items.map(item => {
                const href = `/docs/${item.slug}`;
                const active = pathname === href;
                return (
                  <Link
                    key={item.slug}
                    href={href}
                    className={`sidebar-link ${active ? 'active' : ''}`}
                    onClick={() => setSidebarOpen(false)}
                  >
                    {item.name}
                  </Link>
                );
              })}
            </div>
          ))}
        </aside>
        {/* Content */}
        <main className="lg:ml-[280px] w-full min-w-0 max-w-[900px] px-4 sm:px-6 md:px-16 py-10 pb-20">
          {children}
        </main>
      </div>
      <div className="lg:ml-[280px]">
        <Footer />
      </div>
    </div>
  );
}
