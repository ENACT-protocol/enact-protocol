'use client';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';

const pageMap: Record<string, string> = {
  'What is ENACT': 'what-is-enact', 'Getting Started': 'getting-started',
  'Job Contract': 'smart-contracts', 'Job Wrapper': 'sdk-job',
  'JobFactory Wrapper': 'sdk-factory', 'JobFactory': 'job-factory',
  'JettonJob Wrapper': 'sdk-jetton', 'JettonJob': 'jetton-job',
  'JettonJobFactory': 'jetton-job-factory',
  'MCP Server': 'mcp-server', 'Telegram Bot': 'telegram-bot',
  'Teleton Plugin': 'teleton', 'Teleton': 'teleton',
  'Environment Variables': 'env-vars', 'Mainnet Deployments': 'mainnet',
  'NPM SDK': 'npm-sdk', 'Tech Stack': 'tech-stack', 'Overview': 'what-is-enact',
  'Smart Contracts': 'smart-contracts', 'TypeScript SDK': 'sdk-job',
  'OWS': 'ows', 'Open Wallet Standard': 'ows',
  'Agentic Wallets': 'agentic-wallets', 'Agentic Wallet': 'agentic-wallets',
  'Agent Skills': 'agent-skills', 'Encrypted Results': 'encrypted-results',
  'Python SDK': 'python-sdk', 'LangChain': 'langchain',
};


// Split on existing markdown constructs ([...](...) links and `code` spans) and
// only run substitutions on the plain-text segments. Without this guard the
// LLM's `[agents.ton.org](https://agents.ton.org)` output gets re-wrapped on
// every pass and renders as `[[agents.ton.org](https://agents.ton.org](https://agents.ton.org)`.
function preprocessText(text: string): string {
  const protectedRe = /(\[[^\]]+\]\([^)]+\))|(`[^`]+`)/g;
  const sortedPages = Object.entries(pageMap).sort((a, b) => b[0].length - a[0].length);

  const transformPlain = (segment: string): string => {
    let out = segment;
    // Plain URLs (not already inside a markdown link — protected segments are
    // skipped entirely below, so any URL we see here is unbracketed).
    out = out.replace(/\bhttps?:\/\/[^\s)<>"']+/g, (url) => {
      const trimmed = url.replace(/[.,;:!?]+$/, '');
      const trailing = url.slice(trimmed.length);
      const label = trimmed.replace(/^https?:\/\//, '').replace(/\/$/, '');
      return `[${label}](${trimmed})${trailing}`;
    });
    // Page names → /docs/<slug>
    for (const [name, slug] of sortedPages) {
      const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      out = out.replace(regex, `[${name}](/docs/${slug})`);
    }
    return out;
  };

  // Walk the string, leaving protected segments untouched.
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = protectedRe.exec(text)) !== null) {
    result += transformPlain(text.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  result += transformPlain(text.slice(lastIndex));
  return result;
}

type RelatedPage = { title: string; slug: string };
type Message = {
  role: 'user' | 'assistant';
  text: string;
  filesRead?: number;
  searches?: string[];
  relatedPages?: RelatedPage[];
  typing?: boolean;
  thinking?: boolean;
};

function CopyCodeBtn({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className={`p-0.5 rounded transition-colors cursor-pointer ${copied ? 'text-[#22C55E]' : 'text-[#52525B] hover:text-[#A1A1AA]'}`}>
      {copied
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
    </button>
  );
}

export default function AskAI() {
  const [query, setQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [panelInput, setPanelInput] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [retryIdx, setRetryIdx] = useState<number | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const askAI = async (userMsg: string) => {
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setMessages(prev => [...prev, { role: 'assistant', text: '', thinking: true }]);

    // Build history for context
    const history = messages.filter(m => !m.thinking && m.text).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.text,
    }));

    try {
      const res = await fetch('/api/docs/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, history }),
      });
      const data = await res.json();
      const fullText = data.response || data.error || 'No response';
      const filesRead = data.filesRead || 0;
      const searches: string[] = data.searches || [];
      const relatedPages: RelatedPage[] = data.relatedPages || [];

      // Animate search results appearing one by one
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', text: '', typing: true, filesRead: 0, searches: [], relatedPages };
        return copy;
      });

      // Show "Read N files" with delay
      await new Promise(r => setTimeout(r, 300));
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { ...copy[copy.length - 1], filesRead };
        return copy;
      });

      // Show search results one by one
      for (let s = 0; s < searches.length; s++) {
        await new Promise(r => setTimeout(r, 250));
        setMessages(prev => {
          const copy = [...prev];
          const msg = copy[copy.length - 1];
          copy[copy.length - 1] = { ...msg, searches: searches.slice(0, s + 1) };
          return copy;
        });
      }

      await new Promise(r => setTimeout(r, 300));

      // Type out response
      const speed = Math.max(5, Math.min(20, 600 / fullText.length));
      for (let i = 1; i <= fullText.length; i++) {
        await new Promise(r => setTimeout(r, speed));
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], text: fullText.slice(0, i), typing: i < fullText.length };
          return copy;
        });
      }
    } catch {
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', text: 'Failed to get response.', filesRead: 0 };
        return copy;
      });
    }
  };

  // Lock body scroll when panel open on mobile
  useEffect(() => {
    if (panelOpen && window.innerWidth < 640) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [panelOpen]);

  // Hide AI input when mobile docs sidebar is open
  const [sidebarHidden, setSidebarHidden] = useState(false);
  useEffect(() => {
    const check = () => {
      const isOpen = document.documentElement.hasAttribute('data-sidebar-open');
      setSidebarHidden(isOpen);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sidebar-open'] });
    return () => observer.disconnect();
  }, []);

  const handleSubmit = () => {
    if (!query.trim()) return;
    const msg = query.trim();
    setQuery('');
    setPanelOpen(true);
    window.dispatchEvent(new Event('ai-panel-open'));
    askAI(msg);
  };

  const handlePanelSubmit = () => {
    if (!panelInput.trim()) return;
    const msg = panelInput.trim();
    setPanelInput('');
    askAI(msg);
  };

  const handleClose = () => { setPanelOpen(false); window.dispatchEvent(new Event('ai-panel-close')); };
  const handleClear = () => setMessages([]);

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  const handleRetry = (idx: number) => {
    const userMsg = messages.slice(0, idx).reverse().find(m => m.role === 'user');
    if (!userMsg) return;
    setRetryIdx(idx);
    setTimeout(() => setRetryIdx(null), 500);
    setMessages(prev => prev.filter((_, j) => j !== idx));
    askAI(userMsg.text);
  };

  return (
    <>
      <div className="fixed bottom-4 z-40 transition-all duration-300" style={{ left: '16px', right: '16px', maxWidth: '600px', margin: '0 auto', opacity: sidebarHidden ? 0 : 1, pointerEvents: sidebarHidden ? 'none' : 'auto', transform: sidebarHidden ? 'translateY(20px)' : 'none' }}>
        <div className="flex items-center px-5 py-4 rounded-2xl border border-[rgba(255,255,255,0.12)] shadow-2xl shadow-black/50"
          style={{ background: 'rgba(8,8,12,0.8)', backdropFilter: 'blur(40px) saturate(1.5)', WebkitBackdropFilter: 'blur(40px) saturate(1.5)' }}>
          <input type="text" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="Ask a question about ENACT..."
            className="flex-1 bg-transparent text-[14px] text-white placeholder-[#3F3F46] font-sans focus:outline-none" />
          <button onClick={handleSubmit} className="w-8 h-8 rounded-xl bg-[rgba(0,152,234,0.15)] flex items-center justify-center cursor-pointer ml-2 shrink-0 hover:bg-[rgba(0,152,234,0.25)] transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#0098EA"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>
          </button>
        </div>
      </div>

      {panelOpen && (
        <div className="fixed top-16 right-0 w-full sm:w-[380px] z-50 sm:border-l border-t border-[rgba(255,255,255,0.08)] flex flex-col bg-[#050508]" style={{ height: 'calc(100dvh - 64px)', maxHeight: 'calc(100vh - 64px)' }}>
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center gap-2.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#0098EA"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>
              <span className="text-[15px] font-medium text-[#F4F4F5]">Assistant</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleClear} className="text-[#52525B] hover:text-white transition-colors cursor-pointer">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
              <button onClick={handleClose} className="text-[#52525B] hover:text-white transition-colors cursor-pointer">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>

          <div ref={chatRef} className="flex-1 overflow-y-auto px-5 py-4">
            {messages.map((msg, i) => (
              <div key={i} className={`mb-4 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'user' ? (
                  <div className="rounded-2xl px-4 py-2.5 max-w-[85%] bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)]">
                    <div className="text-[13px] text-[#E4E4E7] leading-relaxed">{msg.text}</div>
                  </div>
                ) : (
                  <div className="w-full">
                    {msg.thinking && (
                      <div className="flex items-center gap-1.5 py-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#52525B] animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-[#52525B] animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-[#52525B] animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    )}

                    {!msg.thinking && msg.filesRead != null && msg.filesRead > 0 && (
                      <div className="mb-3 space-y-1">
                        <div className="flex items-center gap-1.5 text-[11px] text-[#52525B] transition-opacity duration-500">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                          Read {msg.filesRead} file{msg.filesRead > 1 ? 's' : ''}
                        </div>
                        {msg.searches?.map((s, j) => (
                          <div key={j} className="flex items-center gap-1.5 text-[11px] text-[#3F3F46] transition-opacity duration-500" style={{ animationDelay: `${j * 200}ms` }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                            Found results for {s.toLowerCase()}
                          </div>
                        ))}
                      </div>
                    )}

                    {!msg.thinking && msg.text && (
                      <div className="prose-ai text-[13px] text-[#E4E4E7] leading-relaxed">
                        <ReactMarkdown
                          children={preprocessText(msg.text)}
                          components={{
                            code({ children, className }) {
                              const isBlock = className?.startsWith('language-');
                              const code = String(children).replace(/\n$/, '');
                              const lang = className?.replace('language-', '') || 'code';
                              if (isBlock) {
                                return (
                                  <div className="my-2 rounded-lg border border-[rgba(255,255,255,0.06)] overflow-hidden">
                                    <div className="flex items-center justify-between px-3 py-1.5 bg-[rgba(255,255,255,0.04)] border-b border-[rgba(255,255,255,0.06)]">
                                      <span className="text-[10px] text-[#52525B]">{lang}</span>
                                      <CopyCodeBtn code={code} />
                                    </div>
                                    <pre className="px-3 py-2.5 overflow-x-auto text-[12px] font-mono text-[#A1A1AA] bg-[rgba(255,255,255,0.02)]">
                                      <code>{code}</code>
                                    </pre>
                                  </div>
                                );
                              }
                              return <code className="bg-[rgba(255,255,255,0.06)] px-1 py-0.5 rounded text-[12px] font-mono text-[#E4E4E7]">{children}</code>;
                            },
                            p({ children }) { return <p className="mb-2">{children}</p>; },
                            li({ children }) { return <li>{children}</li>; },
                            ol({ children }) { return <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>; },
                            ul({ children }) { return <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>; },
                            a({ href, children }) {
                              const isInternal = href?.startsWith('/');
                              if (isInternal) {
                                return <Link href={href!} className="text-[#0098EA] hover:underline" onClick={() => { if (window.innerWidth < 640) { setPanelOpen(false); window.dispatchEvent(new Event('ai-panel-close')); document.body.style.overflow = ''; } }}>{children}</Link>;
                              }
                              return <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#0098EA] hover:underline">{children}</a>;
                            },
                          }}
                        />
                        {msg.typing && <span className="inline-block w-[2px] h-[13px] bg-[#0098EA] ml-0.5 animate-pulse align-middle" />}
                      </div>
                    )}

                    {!msg.thinking && !msg.typing && msg.relatedPages && msg.relatedPages.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {msg.relatedPages.map((p, j) => (
                          <Link key={j} href={`/docs/${p.slug}`}
                            onClick={() => { if (window.innerWidth < 640) { setPanelOpen(false); window.dispatchEvent(new Event('ai-panel-close')); document.body.style.overflow = ''; } }}
                            className="block text-[13px] text-[#F4F4F5] font-medium hover:text-[#0098EA] transition-colors">
                            {p.title}
                          </Link>
                        ))}
                      </div>
                    )}

                    {!msg.thinking && !msg.typing && msg.text && (
                      <div className="flex items-center gap-3 mt-3">
                        <button onClick={() => handleCopy(msg.text, i)}
                          className={`transition-all duration-300 cursor-pointer ${copiedIdx === i ? 'text-[#22C55E] scale-110' : 'text-[#52525B] hover:text-[#A1A1AA]'}`}>
                          {copiedIdx === i
                            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
                        </button>
                        <button onClick={() => handleRetry(i)}
                          className={`transition-all duration-500 cursor-pointer ${retryIdx === i ? 'text-[#0098EA] rotate-[360deg]' : 'text-[#52525B] hover:text-[#A1A1AA]'}`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="px-4 py-3 border-t border-[rgba(255,255,255,0.06)]">
            <div className="flex items-center px-5 py-4 rounded-2xl border border-[rgba(255,255,255,0.12)]"
              style={{ background: 'rgba(8,8,12,0.8)', backdropFilter: 'blur(40px) saturate(1.5)', WebkitBackdropFilter: 'blur(40px) saturate(1.5)' }}>
              <input type="text" value={panelInput} onChange={e => setPanelInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handlePanelSubmit()}
                placeholder="Ask a question..."
                className="flex-1 bg-transparent text-[14px] text-white placeholder-[#3F3F46] font-sans focus:outline-none" />
              <button onClick={handlePanelSubmit} className="w-7 h-7 rounded-xl bg-[rgba(0,152,234,0.15)] flex items-center justify-center cursor-pointer ml-2 shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#0098EA"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
