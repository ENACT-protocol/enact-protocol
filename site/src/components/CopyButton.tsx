'use client';
import { useState, useRef, useCallback } from 'react';

export default function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'cooldown'>('idle');
  const cooldownRef = useRef(false);

  const handleCopy = useCallback(() => {
    if (cooldownRef.current) return;
    cooldownRef.current = true;

    navigator.clipboard.writeText(text);
    setState('copied');

    setTimeout(() => {
      setState('cooldown');
      setTimeout(() => {
        setState('idle');
        cooldownRef.current = false;
      }, 1000);
    }, 1500);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      aria-label={state === 'copied' ? 'Copied' : 'Copy to clipboard'}
      className="absolute top-1/2 -translate-y-1/2 right-2 w-7 h-7 flex items-center justify-center rounded-md transition-all duration-200 cursor-pointer opacity-0 group-hover:opacity-100 focus:opacity-100 hover:!bg-[rgba(255,255,255,0.12)]"
      style={{
        background: state === 'copied' ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.06)',
        border: '1px solid',
        borderColor: state === 'copied' ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.08)',
      }}
    >
      {state === 'copied' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
