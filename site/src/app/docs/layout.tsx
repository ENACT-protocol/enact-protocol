'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Header from '@/components/Header';
import AskAI from '@/components/AskAI';
import { Information, DocumentCode, Code1, Setting2 } from 'iconsax-react';

/* ── Glass icon (Iconsax custom) ── */
const GlassIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#636370" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.16 22C3.98 22 3.14 19.47 4.5 16.39L8.75 6.74H8.45C7.8 6.74 7.2 6.48 6.77 6.05C6.33 5.62 6.07 5.02 6.07 4.37C6.07 3.07 7.13 2 8.44 2H15.55C16.21 2 16.8 2.27 17.23 2.7C17.79 3.26 18.07 4.08 17.86 4.95C17.59 6.03 16.55 6.74 15.44 6.74H15.28L19.5 16.4C20.85 19.48 19.97 22 15.83 22H8.16Z"/>
    <path d="M5.94 13.12S9 13 12 14C15 15 17.83 13.11 17.83 13.11"/>
  </svg>
);

/* ── Group icons ── */
const groupIcons: Record<string, React.ReactNode> = {
  'Overview': <Information size={15} variant="Linear" color="#636370" />,
  'Smart Contracts': <DocumentCode size={15} variant="Linear" color="#636370" />,
  'TypeScript SDK': <Code1 size={15} variant="Linear" color="#636370" />,
  'Integrations': <GlassIcon />,
  'Reference': <Setting2 size={15} variant="Linear" color="#636370" />,
};

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
    { name: 'Encrypted Results', slug: 'encrypted-results' },
  ]},
  { group: 'Integrations', items: [
    { name: 'MCP Server', slug: 'mcp-server' },
    { name: 'Telegram Bot', slug: 'telegram-bot' },
    { name: 'Teleton Plugin', slug: 'teleton' },
    { name: 'Open Wallet Standard', slug: 'ows' },
    { name: 'Agentic Wallets', slug: 'agentic-wallets', badge: 'NEW' as const },
    { name: 'Agent Skills', slug: 'agent-skills' },
    { name: 'LangChain', slug: 'langchain' },
  ]},
  { group: 'Reference', items: [
    { name: 'Environment Variables', slug: 'env-vars' },
    { name: 'Mainnet Deployments', slug: 'mainnet' },
    { name: 'NPM SDK', slug: 'npm-sdk' },
    { name: 'Python SDK', slug: 'python-sdk' },
    { name: 'Tech Stack', slug: 'tech-stack' },
  ]},
];

/* ── Static "On this page" headings per slug ─────────── */
const tocMap: Record<string, { label: string; anchor: string }[]> = {
  'encrypted-results': [
    { label: 'How It Works', anchor: 'how-it-works' },
    { label: 'Encryption Flow', anchor: 'encryption-flow' },
    { label: 'SDK Usage', anchor: 'sdk-usage' },
    { label: 'Decrypting Results', anchor: 'decrypting-results' },
    { label: 'Explorer Display', anchor: 'explorer-display' },
    { label: 'Security Model', anchor: 'security-model' },
  ],
  'what-is-enact': [
    { label: 'How It Works', anchor: 'how-it-works' },
    { label: 'Example: Agent Commerce', anchor: 'example-agent-commerce-in-action' },
    { label: 'Key Features', anchor: 'key-features' },
    { label: 'Quick Start', anchor: 'quick-start' },
    { label: 'AI Evaluator Agent', anchor: 'ai-evaluator-agent' },
    { label: 'Roadmap', anchor: 'roadmap' },
  ],
  'getting-started': [
    { label: 'Prerequisites', anchor: 'prerequisites' },
    { label: 'Quick Start Paths', anchor: 'quick-start-paths' },
    { label: 'Step 1 — Clone & Install', anchor: 'step-1-clone-install' },
    { label: 'Step 2 — Build Contracts', anchor: 'step-2-build-contracts' },
    { label: 'Step 3 — Run Tests', anchor: 'step-3-run-tests' },
    { label: 'Step 4 — Connect to Mainnet', anchor: 'step-4-connect-to-mainnet' },
    { label: 'End-to-End Example', anchor: 'end-to-end-example' },
    { label: 'Next Steps', anchor: 'next-steps' },
  ],
  'smart-contracts': [
    { label: 'State Machine', anchor: 'state-machine' },
    { label: 'Roles', anchor: 'roles' },
    { label: 'Opcodes', anchor: 'opcodes' },
  ],
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeSection, setActiveSection] = useState('');

  // Derive current slug from pathname
  const currentSlug = pathname.replace('/docs/', '').replace('/docs', '');
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  // Listen for AI panel open/close events
  useEffect(() => {
    const onOpen = () => setAiPanelOpen(true);
    const onClose = () => setAiPanelOpen(false);
    window.addEventListener('ai-panel-open', onOpen);
    window.addEventListener('ai-panel-close', onClose);
    return () => { window.removeEventListener('ai-panel-open', onOpen); window.removeEventListener('ai-panel-close', onClose); };
  }, []);

  const staticToc = tocMap[currentSlug] || [];
  const [dynamicToc, setDynamicToc] = useState<{ label: string; anchor: string }[]>([]);
  const toc = staticToc.length > 0 ? staticToc : dynamicToc;

  // Auto-extract TOC from DOM h2 headings when no static map exists
  useEffect(() => {
    if (staticToc.length > 0) return;
    const timer = setTimeout(() => {
      const headings = document.querySelectorAll('main h2[id]');
      const items = Array.from(headings).map(h => ({
        label: h.textContent || '',
        anchor: h.id,
      }));
      setDynamicToc(items);
    }, 200);
    return () => clearTimeout(timer);
  }, [pathname, staticToc.length]);

  // Toggle body class for mobile sidebar (hides AI input)
  useEffect(() => {
    if (sidebarOpen && window.innerWidth < 768) {
      document.documentElement.setAttribute('data-sidebar-open', 'true');
    } else {
      document.documentElement.removeAttribute('data-sidebar-open');
    }
  }, [sidebarOpen]);

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

  // Track active section via IntersectionObserver
  useEffect(() => {
    if (toc.length === 0) return;
    const headings = toc.map(t => document.getElementById(t.anchor)).filter(Boolean) as HTMLElement[];
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );

    headings.forEach(h => observer.observe(h));
    return () => observer.disconnect();
  }, [pathname, toc]);

  const toggleGroup = (group: string) => {
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <div className="min-h-screen">
      <Header />

      {/* Mobile sidebar toggle */}
      <div className="md:hidden sticky top-16 z-30 flex items-center px-4 py-2.5 border-b border-[rgba(255,255,255,0.06)] bg-[#050508]">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="flex items-center gap-2 text-[#A1A1AA] text-[13px] cursor-pointer">
          {sidebarOpen
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>}
          Menu
        </button>
      </div>

      <div className={`pt-16 flex relative mx-auto transition-all duration-300 ${aiPanelOpen ? 'max-w-none sm:pr-[380px] px-0' : 'max-w-[1400px] px-0 lg:px-6'}`}>

        {/* Overlay for mobile sidebar */}
        {sidebarOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/60 z-40"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside className={`
          fixed lg:sticky top-16 left-0 w-[240px] h-[calc(100vh-64px)] overflow-y-auto
          border-r border-[rgba(255,255,255,0.06)]
          py-5 pb-40 z-40 bg-[#050508] [&]::-webkit-scrollbar{display:none} [-ms-overflow-style:none] [scrollbar-width:none]
          transition-transform duration-300 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          md:shrink-0 md:sticky md:h-[calc(100vh-64px)]
        `}>
          {sidebar.map(group => (
              <div key={group.group} className="mb-5">
                <div className="flex items-center gap-2 px-5 py-1.5 text-[13px] font-semibold text-[#636370]">
                  {groupIcons[group.group]}
                  {group.group}
                </div>
                <div className="mt-0.5">
                  {group.items.map(item => {
                    const href = `/docs/${item.slug}`;
                    const active = pathname === href;
                    const badge = (item as { badge?: string }).badge;
                    return (
                      <Link
                        key={item.slug}
                        href={href}
                        onClick={() => setSidebarOpen(false)}
                        className={`
                          flex items-center gap-2 text-[13px] py-2 pl-10 pr-4 mx-2 rounded-lg transition-all duration-150
                          ${active
                            ? 'text-[#0098EA] bg-[rgba(0,152,234,0.08)]'
                            : 'text-[#A1A1AA] hover:text-[#F4F4F5]'
                          }
                        `}
                      >
                        <span className="flex-1 truncate">{item.name}</span>
                        {badge && (
                          <span className="shrink-0 px-1.5 py-px text-[9px] font-mono font-semibold tracking-[0.08em] uppercase rounded-md bg-gradient-to-b from-[rgba(0,152,234,0.18)] to-[rgba(0,152,234,0.08)] text-[#5BB8F0] border border-[rgba(0,152,234,0.25)]">
                            {badge}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0 px-4 sm:px-8 py-10 pb-24 docs-main">
          <div className="w-full max-w-[750px]">
            {children}
          </div>
        </main>

        {/* On this page — right column (desktop only, always show) */}
        <div className="hidden lg:block sticky top-16 w-[170px] shrink-0 h-[calc(100vh-64px)] py-10 overflow-y-auto">
          <div className="flex items-center gap-2 mb-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#52525B" strokeWidth="1.5" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            <span className="text-[13px] font-semibold text-[#52525B]">On this page</span>
          </div>
          {toc.length > 0 ? (
            <nav className="space-y-0.5">
              {toc.map(item => {
                const isActive = activeSection === item.anchor;
                return (
                  <a key={item.anchor} href={`#${item.anchor}`}
                    className={`block text-[13px] py-1 transition-all duration-150 ${isActive ? 'text-[#0098EA]' : 'text-[#636370] hover:text-[#A1A1AA]'}`}>
                    {item.label}
                  </a>
                );
              })}
            </nav>
          ) : (
            <span className="text-[12px] text-[#3F3F46]">No sections</span>
          )}
        </div>

        <AskAI />
      </div>
    </div>
  );
}
