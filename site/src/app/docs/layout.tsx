'use client';
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

  return (
    <div className="min-h-screen">
      <Header />
      <div className="pt-16 flex">
        {/* Sidebar */}
        <aside className="hidden lg:block fixed top-16 left-0 w-[280px] h-[calc(100vh-64px)] overflow-y-auto border-r border-[var(--color-border)] bg-[#07070A] py-6">
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
                  >
                    {item.name}
                  </Link>
                );
              })}
            </div>
          ))}
        </aside>
        {/* Content */}
        <main className="lg:ml-[280px] w-full max-w-[900px] px-6 md:px-16 py-10 pb-20">
          {children}
        </main>
      </div>
      <div className="lg:ml-[280px]">
        <Footer />
      </div>
    </div>
  );
}
