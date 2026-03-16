import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../constants';
import { spaceGrotesk, jetbrainsMono } from '../fonts';
import { fadeIn, slideUp } from '../utils';

const ITEMS = [
  { num: '01', name: 'MCP Server', detail: '15 tools \u00B7 mcp.enact.info' },
  { num: '02', name: 'Telegram Bot', detail: '@EnactProtocolBot \u00B7 20 commands' },
  { num: '03', name: 'TypeScript SDK', detail: '@enact-protocol/sdk' },
  { num: '04', name: 'Teleton Plugin', detail: '15 tools \u00B7 autonomous agents' },
];

export const S14_Integrations: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = (s: number) => Math.round(s * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg, justifyContent: 'center', padding: '80px 160px' }}>
      {ITEMS.map((item, i) => {
        const start = f(i * 0.3);
        return (
          <div
            key={item.num}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 24,
              opacity: fadeIn(frame, start, f(0.25)),
              transform: `translateY(${slideUp(frame, start, f(0.25))}px)`,
              marginBottom: 20,
              paddingBottom: 20,
              borderBottom: `1px solid ${COLORS.terminalBorder}`,
            }}
          >
            <div style={{ fontFamily: jetbrainsMono, fontSize: 20, color: COLORS.accent, minWidth: 44 }}>
              {item.num}
            </div>
            <div style={{ fontFamily: spaceGrotesk, fontWeight: 700, fontSize: 36, color: COLORS.text, minWidth: 340 }}>
              {item.name}
            </div>
            <div style={{ fontFamily: jetbrainsMono, fontSize: 24, color: COLORS.textDim }}>
              {item.detail}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
