export const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
export const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
export const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];

export const OPCODES: Record<number, string> = {
  0x01: 'Funded',
  0x02: 'Taken',
  0x03: 'Submitted',
  0x04: 'Evaluated',
  0x05: 'Cancelled',
  0x06: 'Created',
  0x07: 'Claimed',
  0x08: 'Quit',
  0x09: 'BudgetSet',
  0x0a: 'WalletSet',
};

export interface JobRow {
  job_id: number;
  factory_type: 'ton' | 'usdt';
  address: string;
  factory_address: string;
  state: number;
  state_name: string;
  client: string;
  provider: string | null;
  evaluator: string;
  budget: number;
  budget_formatted: string;
  desc_hash: string;
  result_hash: string;
  timeout: number;
  created_at: number;
  eval_timeout: number;
  submitted_at: number;
  result_type: number;
  description_text: string | null;
  description_ipfs_url: string | null;
  result_text: string | null;
  result_ipfs_url: string | null;
  reason_text: string | null;
}

export interface TxRow {
  job_address: string;
  tx_hash: string;
  fee: string;
  utime: number;
  opcode: number | null;
  event_type: string | null;
  from_address: string | null;
}

export interface ActivityRow {
  job_id: number;
  factory_type: string;
  job_address: string;
  event: string;
  status: string;
  time: number;
  amount: string | null;
  from_address: string | null;
  tx_hash: string | null;
}
