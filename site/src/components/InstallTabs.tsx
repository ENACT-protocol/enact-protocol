'use client';
import { useState, useMemo } from 'react';
import CopyButton from '@/components/CopyButton';

/* ── Brand logos (official SVGs, original colors) ── */
const logos: Record<string, React.ReactNode> = {
  Cursor: <img src="/logos/cursor.svg" alt="Cursor" width={18} height={18} />,
  'Claude Code': <img src="/logos/claude.svg" alt="Claude" width={18} height={18} />,
  Codex: <img src="/logos/codex.svg" alt="Codex" width={18} height={18} />,
  Other: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
    </svg>
  ),
};

export interface TabConfig {
  label: string;
  hint: string;
  lang: string;
  code: string;
  /** JSON config for Cursor deeplink */
  cursorConfig?: Record<string, unknown>;
}

/* ── Code block with copy ── */
function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={`relative group ${className ?? ''}`}>
      <pre className="install-pre pr-16" style={{ whiteSpace: 'pre-wrap' }}>{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

/* ── Cursor: one-click install button + JSON fallback ── */
function CursorPanel({ tab }: { tab: TabConfig }) {
  const deeplink = useMemo(() => {
    if (!tab.cursorConfig) return null;
    const json = JSON.stringify(tab.cursorConfig);
    const b64 = btoa(json);
    const name = Object.keys(tab.cursorConfig)[0] ?? 'enact';
    return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(name)}&config=${encodeURIComponent(b64)}`;
  }, [tab.cursorConfig]);

  return (
    <div className="install-panel">
      {deeplink && (
        <>
          <a
            href={deeplink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2.5 w-full py-3 rounded-lg mb-2 font-mono text-sm text-white transition-all duration-200 hover:brightness-125 cursor-pointer"
            style={{
              background: 'linear-gradient(135deg, #1A1A24 0%, #12121A 100%)',
              border: '1px solid #2A2A36',
            }}
          >
            <img src="/logos/cursor.svg" alt="" width={16} height={16} />
            Install in Cursor
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 17L17 7M17 7H7M17 7v10" /></svg>
          </a>
          <div className="text-[10px] text-gray-600 font-mono mb-5 text-center">
            Opens Cursor and installs automatically. The browser tab will close itself.
          </div>
        </>
      )}

      <div className="text-[11px] font-mono text-[var(--color-text-dim)] uppercase tracking-wider mb-2">
        {deeplink ? 'Or add manually to' : 'Add to'} <span className="text-gray-400">.cursor/mcp.json</span>
      </div>
      <CodeBlock code={tab.code} />
    </div>
  );
}

/* ── Claude Code: CLI command ── */
function ClaudeCodePanel({ tab }: { tab: TabConfig }) {
  return (
    <div className="install-panel">
      <div className="text-[11px] font-mono text-[var(--color-text-dim)] uppercase tracking-wider mb-2">
        Run in terminal
      </div>
      <CodeBlock code={tab.code} />
      <div className="mt-3 text-[11px] text-gray-600 font-mono">
        Verify with <span className="text-gray-500">claude mcp list</span>
      </div>
    </div>
  );
}

/* ── Codex: TOML config ── */
function CodexPanel({ tab }: { tab: TabConfig }) {
  return (
    <div className="install-panel">
      <div className="flex flex-col gap-2.5 mb-4">
        {[
          ['1', 'Open codex.toml or run codex --configure'],
          ['2', 'Add the config below to [mcp_servers]'],
        ].map(([n, text]) => (
          <div key={n} className="flex items-center gap-3">
            <span
              className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#888' }}
            >{n}</span>
            <span className="text-[12px] text-gray-400 font-mono">{text}</span>
          </div>
        ))}
      </div>
      <CodeBlock code={tab.code} />
    </div>
  );
}

/* ── Other: generic server info ── */
function OtherPanel({ tab }: { tab: TabConfig }) {
  return (
    <div className="install-panel">
      <div className="text-[11px] font-mono text-[var(--color-text-dim)] uppercase tracking-wider mb-3">
        Use these credentials in any MCP-compatible client
      </div>
      <CodeBlock code={tab.code} />
    </div>
  );
}

/* ── Generic fallback ── */
function GenericPanel({ tab }: { tab: TabConfig }) {
  return (
    <div className="install-panel">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-mono text-[var(--color-text-dim)] uppercase tracking-wider">{tab.hint}</span>
        <span className="text-[10px] font-mono text-[var(--color-text-dim)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 rounded">{tab.lang}</span>
      </div>
      <CodeBlock code={tab.code} />
    </div>
  );
}

const panels: Record<string, React.FC<{ tab: TabConfig }>> = {
  Cursor: CursorPanel,
  'Claude Code': ClaudeCodePanel,
  Codex: CodexPanel,
  Other: OtherPanel,
};

export default function InstallTabs({ tabs }: { tabs: TabConfig[] }) {
  const [active, setActive] = useState(0);
  const current = tabs[active];
  const Panel = panels[current.label] ?? GenericPanel;

  return (
    <div className="install-tabs my-8">
      <div className="flex border-b border-[var(--color-border)]">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            onClick={() => setActive(i)}
            className={`install-tab ${i === active ? 'active' : ''}`}
          >
            {logos[t.label] ?? null}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <Panel tab={current} />
    </div>
  );
}
