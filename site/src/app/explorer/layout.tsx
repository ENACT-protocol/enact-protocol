import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Explorer — ENACT Protocol',
  description: 'Browse ENACT Protocol jobs and factories on TON Mainnet. View job statuses, transactions, and on-chain activity.',
};

export default function ExplorerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
