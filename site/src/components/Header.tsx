'use client';
import { useState, useRef, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

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

const TonUsdtIcon = ({ type }: { type: string }) => type === 'ton'
  ? <svg width="12" height="12" viewBox="16 18 24 24" fill="none" className="inline-block shrink-0 align-middle"><path fillRule="evenodd" clipRule="evenodd" d="M20.199 18.4844H35.9034C36.459 18.4844 37.0142 18.566 37.5944 18.8365C38.2899 19.1606 38.6587 19.6717 38.9171 20.0496C38.9372 20.079 38.956 20.1093 38.9734 20.1403C39.2772 20.6811 39.4338 21.265 39.4338 21.8931C39.4338 22.4899 39.2918 23.1401 38.9734 23.7068L29.0424 40.7665C28.8236 41.1423 28.4209 41.3729 27.986 41.3714C27.5511 41.3698 27.15 41.1364 26.9339 40.759L17.1943 23.7518C16.963 23.3707 16.6183 22.8027 16.558 22.0696C16.5026 21.3956 16.6541 20.7202 16.9928 20.1346C17.3315 19.5489 17.8414 19.0807 18.4547 18.7941C19.1123 18.4868 19.7787 18.4844 20.199 18.4844ZM26.7729 20.9192H20.199C19.7671 20.9192 19.6013 20.9458 19.4854 21C19.3251 21.0748 19.1905 21.1978 19.1005 21.3535C19.0105 21.5092 18.9698 21.6896 18.9846 21.8701C18.9931 21.9737 19.0353 22.0921 19.2842 22.5026L26.7729 35.5785V20.9192ZM29.2077 20.9192V35.643L36.8542 22.5079C36.9405 22.3511 36.999 22.1245 36.999 21.8931C36.999 21.7054 36.9601 21.5424 36.8731 21.3743C36.7818 21.2431 36.7262 21.1736 36.6797 21.126C36.6398 21.0853 36.6091 21.0635 36.5657 21.0433C36.3849 20.959 36.1999 20.9192 35.9034 20.9192H29.2077Z" fill="#0098EA"/></svg>
  : <img src="/usdt-icon.svg" alt="USDT" width={12} height={12} className="inline-block shrink-0 align-middle" />;

const TonscanSvg = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path fill="currentColor" d="M4.14 6.881c0 .199.483.684.84.676.358-.007.88-.452.88-.676 0-.223-.523-.257-.839-.257s-.88.059-.88.257M2.677 5.679c.517.201 1.04.09 1.168-.247s-.189-.774-.706-.976-.958-.225-1.086.113c-.127.337.107.908.624 1.11M6.158 5.432c.128.338.66.425 1.15.188.488-.236.717-.713.59-1.051-.128-.338-.517-.315-1.035-.113s-.833.639-.705.976"/><path fill="currentColor" fillRule="evenodd" d="M1.814.343c.435.267.995.698 1.677 1.284Q4.4 1.469 5 1.468q.597.001 1.494.159C7.18 1.053 7.742.628 8.175.362c.227-.14.437-.247.62-.304.163-.05.414-.097.626.05a.7.7 0 0 1 .249.35q.066.19.093.443c.037.336.035.801-.012 1.414q-.045.581-.157 1.22c.404.768.503 1.627.314 2.557-.186.912-.784 1.726-1.672 2.468C7.368 9.285 6.292 10 4.99 10c-1.29 0-2.57-.733-3.338-1.454C.9 7.84.395 7.143.16 6.342-.114 5.416-.033 4.48.386 3.55q-.121-.67-.156-1.24C.188 1.59.177 1.13.21.824.225.67.254.531.31.411A.75.75 0 0 1 .544.118c.209-.16.462-.127.637-.077.19.054.403.16.633.302M.982.738.96.732A1 1 0 0 0 .93.9c-.025.237-.02.64.024 1.368q.032.56.165 1.262l.022.116-.051.107C.697 4.574.626 5.363.854 6.138c.186.632.595 1.222 1.295 1.88.686.644 1.798 1.257 2.842 1.257 1.033 0 1.938-.567 2.78-1.27.82-.687 1.286-1.368 1.426-2.057.169-.829.063-1.545-.297-2.171l-.066-.116.024-.131q.125-.675.17-1.27c.046-.594.044-1.009.014-1.28a1.5 1.5 0 0 0-.039-.227c-.1.032-.247.103-.45.227-.412.253-.984.686-1.721 1.31L6.7 2.4l-.169-.03C5.88 2.25 5.372 2.193 5 2.193q-.555-.001-1.552.177l-.17.03-.132-.113C2.414 1.65 1.846 1.212 1.435.96A2 2 0 0 0 .982.738" clipRule="evenodd"/></svg>
);

function SearchResultRow({ job: j, onSelect }: { job: SearchJob; onSelect: (addr: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copyAddr = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    navigator.clipboard.writeText(j.address);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div onMouseDown={() => onSelect(j.address)}
      className="w-full text-left px-3 py-2.5 hover:bg-[#ffffff08] rounded-md transition-colors cursor-pointer flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="inline-flex items-center gap-1 shrink-0"><span className="text-white font-medium text-[12px]">#{j.jobId}</span> <TonUsdtIcon type={j.type} /></span>
        <span className={`font-mono text-[10px] shrink-0 cursor-pointer transition-colors ${copied ? 'text-[#22C55E]' : 'text-white hover:text-[#A1A1AA]'}`}
          onMouseDown={copyAddr}>{copied ? 'Copied!' : `${j.address.slice(0, 6)}…${j.address.slice(-4)}`}</span>
        <a href={`https://tonscan.org/address/${j.address}`} target="_blank" rel="noopener noreferrer"
          onMouseDown={e => e.stopPropagation()} className="text-[#52525B] hover:text-white transition-colors shrink-0"><TonscanSvg /></a>
        <span className="w-1" />
        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono shrink-0 bg-[#ffffff0a] ${
          j.stateName === 'COMPLETED' ? 'border-[#22C55E33] text-[#22C55E]' :
          j.stateName === 'FUNDED' ? 'border-[#3B82F633] text-[#60A5FA]' :
          j.stateName === 'OPEN' ? 'border-[#FACC1533] text-[#FACC15]' :
          j.stateName === 'DISPUTED' ? 'border-[#EF444433] text-[#EF4444]' :
          j.stateName === 'CANCELLED' ? 'border-[#6B728033] text-[#6B7280]' :
          'border-[#A78BFA33] text-[#A78BFA]'
        }`}>{j.stateName}</span>
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <span className="text-[11px] text-white font-medium">{j.budgetFormatted}</span>
        <TonUsdtIcon type={j.type} />
      </span>
    </div>
  );
}

const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4.5L6 7.5L9 4.5" />
  </svg>
);

type SearchJob = { jobId: number; address: string; type: string; stateName: string; budgetFormatted: string; client: string; evaluator: string; provider: string };

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [headerSearch, setHeaderSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [allJobs, setAllJobs] = useState<SearchJob[]>([]);
  const moreTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pathname = usePathname();
  const router = useRouter();

  // Fetch jobs for search
  useEffect(() => {
    fetch('/api/explorer').then(r => r.json()).then(d => {
      if (d?.tonJobs || d?.jettonJobs) {
        const jobs = [...(d.tonJobs || []), ...(d.jettonJobs || [])].map((j: any) => ({
          jobId: j.jobId, address: j.address, type: j.type, stateName: j.stateName, budgetFormatted: j.budgetFormatted, client: j.client || '', evaluator: j.evaluator || '', provider: j.provider || '',
        }));
        setAllJobs(jobs);
      }
    }).catch(() => {});
  }, []);

  const searchResults = useMemo(() => {
    const q = headerSearch.trim().toLowerCase();
    if (!q || !allJobs.length) return [];
    const isNum = /^\d+$/.test(q);

    if (isNum) {
      // Search by job ID — only jobs whose ID starts with the query
      const matches = allJobs.filter(j => String(j.jobId).startsWith(q));
      const num = parseInt(q);
      matches.sort((a, b) => {
        if (a.jobId === num && b.jobId !== num) return -1;
        if (b.jobId === num && a.jobId !== num) return 1;
        return a.jobId - b.jobId;
      });
      return matches.slice(0, 30);
    } else {
      // Search by address — contract address OR wallet (client/evaluator/provider)
      const matches = allJobs.filter(j =>
        j.address?.toLowerCase().includes(q) ||
        j.client?.toLowerCase().includes(q) ||
        j.evaluator?.toLowerCase().includes(q) ||
        (j.provider && j.provider !== 'none' && j.provider.toLowerCase().includes(q))
      );
      matches.sort((a, b) => {
        // Exact contract address match first
        const aContract = a.address?.toLowerCase().includes(q) ? 0 : 1;
        const bContract = b.address?.toLowerCase().includes(q) ? 0 : 1;
        if (aContract !== bContract) return aContract - bContract;
        return b.jobId - a.jobId;
      });
      return matches.slice(0, 30);
    }
  }, [headerSearch, allJobs]);

  const isActive = (path: string) => path === '/' ? pathname === '/' : pathname?.startsWith(path);

  const handleMoreEnter = () => {
    clearTimeout(moreTimeout.current);
    setMoreOpen(true);
  };
  const handleMoreLeave = () => {
    moreTimeout.current = setTimeout(() => setMoreOpen(false), 150);
  };

  const handleSearchSelect = (addr: string) => {
    router.push(`/explorer/job/${addr}`);
    setHeaderSearch('');
    setSearchFocused(false);
  };

  const navLink = (href: string, label: string, activePrefix?: string) => (
    <Link href={href} className={`text-[13px] px-3 py-1.5 transition-colors relative ${
      isActive(activePrefix || href)
        ? 'text-[#0098EA] font-medium after:absolute after:bottom-[-18px] after:left-3 after:right-3 after:h-[2px] after:bg-[#0098EA] after:rounded-full'
        : 'text-[#A1A1AA] hover:text-white'
    }`}>{label}</Link>
  );

  return (
    <nav className="fixed top-0 left-0 w-full z-50 glass-panel border-b border-[#ffffff0f]">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 h-16 flex items-center justify-between">
        <div className="flex items-center gap-5">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <img src="/enact_without.png" alt="ENACT" className="h-10 w-10" />
            <span className="font-serif italic text-[17px] tracking-tight text-white">
              ENACT<span className="font-sans not-italic font-light text-[13px] text-[#636370] ml-1.5 relative -top-0.5">Protocol</span>
            </span>
          </Link>
          <div className="hidden md:flex items-center gap-0.5 ml-2">
            {navLink('/', 'Home')}
            {navLink('/docs/getting-started', 'Docs', '/docs')}
            {navLink('/explorer', 'Explorer')}
            <div className="relative" onMouseEnter={handleMoreEnter} onMouseLeave={handleMoreLeave}>
              <button className="text-[13px] px-3 py-1.5 text-[#A1A1AA] hover:text-white transition-colors inline-flex items-center gap-1 cursor-pointer">
                More <ChevronDown />
              </button>
              {moreOpen && (
                <div className="absolute top-full left-0 mt-3 w-[180px] rounded-[10px] border border-[#ffffff14] bg-[#0A0A0F] p-1.5 shadow-xl shadow-black/40"
                  style={{ animation: 'dropdown-enter 0.25s ease-out' }}>
                  <a href="/#mechanism" className="block px-3.5 py-2 text-[13px] text-[#A1A1AA] hover:text-white hover:bg-[#ffffff08] rounded-md transition-colors">Protocol</a>
                  <a href="/#specification" className="block px-3.5 py-2 text-[13px] text-[#A1A1AA] hover:text-white hover:bg-[#ffffff08] rounded-md transition-colors">Specification</a>
                  <a href="/#architecture" className="block px-3.5 py-2 text-[13px] text-[#A1A1AA] hover:text-white hover:bg-[#ffffff08] rounded-md transition-colors">Architecture</a>
                  <a href="/#ecosystem" className="block px-3.5 py-2 text-[13px] text-[#A1A1AA] hover:text-white hover:bg-[#ffffff08] rounded-md transition-colors">Ecosystem</a>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2">
          <div className="relative">
            <input type="text" value={headerSearch}
              onChange={e => setHeaderSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
              onKeyDown={e => { if (e.key === 'Enter' && searchResults.length > 0) handleSearchSelect(searchResults[0].address); }}
              placeholder="Search by address or job ID..."
              className="w-[240px] bg-[#ffffff08] border border-[#ffffff0f] border-subtle px-3.5 py-[7px] text-[12px] text-white placeholder-[#52525B] font-mono focus:outline-none focus:border-[#0098EA] transition-colors" />
            {searchFocused && headerSearch.trim() && (
              <div className="absolute top-full left-0 w-[380px] mt-1.5 rounded-lg border border-[#ffffff14] bg-[#0A0A0F] p-1.5 shadow-xl shadow-black/40 z-50 max-h-[280px] overflow-y-auto"
                style={{ animation: 'dropdown-enter 0.15s ease-out' }}>
                {searchResults.length > 0 ? searchResults.map(j => (
                  <SearchResultRow key={j.address} job={j} onSelect={handleSearchSelect} />
                )) : (
                  <div className="px-3 py-2 text-[12px] text-[#52525B]">No results</div>
                )}
              </div>
            )}
          </div>
          <a href="https://t.me/EnactProtocolBot" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3.5 py-[7px] border-subtle text-[#0098EA] hover:bg-[#0098EA]/5 transition-colors">
            <TelegramIcon /> Bot
          </a>
          <a href="https://x.com/EnactProtocol" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3.5 py-[7px] border-subtle text-white hover:bg-white/5 transition-colors">
            <XIcon /> X
          </a>
          <a href="https://github.com/ENACT-protocol" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3.5 py-[7px] border-subtle text-white hover:bg-white/5 transition-colors">
            <i className="hgi-stroke hgi-github" style={{ fontSize: 14 }} /> GitHub
          </a>
        </div>
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
      {mobileOpen && (
        <div className="md:hidden glass-panel border-t border-[#ffffff0f] px-4 pb-6 pt-4">
          <div className="flex flex-col space-y-4">
            <Link href="/explorer" onClick={() => setMobileOpen(false)} className="text-[13px] text-[#A1A1AA] hover:text-white transition-colors py-1">Explorer</Link>
            <Link href="/docs/getting-started" onClick={() => setMobileOpen(false)} className="text-[13px] text-[#A1A1AA] hover:text-white transition-colors py-1">Docs</Link>
            <a href="/#mechanism" onClick={() => setMobileOpen(false)} className="text-[13px] text-[#A1A1AA] hover:text-white transition-colors py-1">Protocol</a>
            <a href="/#specification" onClick={() => setMobileOpen(false)} className="text-[13px] text-[#A1A1AA] hover:text-white transition-colors py-1">Specification</a>
            <a href="/#architecture" onClick={() => setMobileOpen(false)} className="text-[13px] text-[#A1A1AA] hover:text-white transition-colors py-1">Architecture</a>
            <a href="/#ecosystem" onClick={() => setMobileOpen(false)} className="text-[13px] text-[#A1A1AA] hover:text-white transition-colors py-1">Ecosystem</a>
            <div className="border-t border-[#ffffff0f] pt-4 flex items-center gap-2">
              <a href="https://t.me/EnactProtocolBot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#ffffff0f] text-[#0098EA]">
                <TelegramIcon /> Bot
              </a>
              <a href="https://x.com/EnactProtocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#ffffff0f] text-white">
                <XIcon /> X
              </a>
              <a href="https://github.com/ENACT-protocol" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#ffffff0f] text-white">
                <i className="hgi-stroke hgi-github" style={{ fontSize: 14 }} /> GitHub
              </a>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
