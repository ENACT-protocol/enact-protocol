import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Bot, InlineKeyboard } from 'grammy';
import { Address, beginCell, toNano, Cell } from '@ton/core';
import TonConnect, { IStorage } from '@tonconnect/sdk';
import {
    createClient, createWalletFromMnemonic, sendTx,
    getJobStatus, getFactoryJobCount, getJobAddress,
    FactoryOpcodes, JobOpcodes, fmtTon, fmtUsdt, explorerLink,
    FACTORY_ADDRESS, JETTON_FACTORY_ADDRESS,
} from './utils';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1); }

const MANIFEST_URL = 'https://www.enact.info/tonconnect-manifest.json';

const bot = new Bot(BOT_TOKEN);
bot.catch((err) => console.error('Bot error:', err.message ?? err));

// ─── Persistent storage ───
const DATA_DIR = path.join(__dirname, '..', 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const DESCRIPTIONS_FILE = path.join(DATA_DIR, 'descriptions.json');

// Mnemonic wallets (advanced mode)
const userWallets = new Map<number, string[]>();
// TonConnect sessions
const userConnectors = new Map<number, TonConnect>();
// TonConnect connected addresses
const userTcAddresses = new Map<number, string>();

interface WalletData {
    mnemonics: Record<string, string[]>;
    tcAddresses: Record<string, string>;
}

function loadWallets() {
    try {
        if (fs.existsSync(WALLETS_FILE)) {
            const data: WalletData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
            for (const [id, words] of Object.entries(data.mnemonics ?? {})) {
                userWallets.set(Number(id), words);
            }
            for (const [id, addr] of Object.entries(data.tcAddresses ?? {})) {
                userTcAddresses.set(Number(id), addr);
            }
            console.log(`Restored ${userWallets.size} mnemonic + ${userTcAddresses.size} TonConnect wallets`);
        }
    } catch {
        console.log('No saved wallets found');
    }
}

function saveWallets() {
    const data: WalletData = {
        mnemonics: Object.fromEntries([...userWallets.entries()].map(([k, v]) => [String(k), v])),
        tcAddresses: Object.fromEntries([...userTcAddresses.entries()].map(([k, v]) => [String(k), v])),
    };
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2));
}

// ─── Job descriptions storage (on-chain only has hash) ───
const jobDescriptions = new Map<number, string>();

function loadDescriptions() {
    try {
        if (fs.existsSync(DESCRIPTIONS_FILE)) {
            const data: Record<string, string> = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf-8'));
            for (const [id, desc] of Object.entries(data)) {
                jobDescriptions.set(Number(id), desc);
            }
            console.log(`Restored ${jobDescriptions.size} job descriptions`);
        }
    } catch {
        console.log('No saved descriptions found');
    }
}

function saveDescription(jobId: number, description: string) {
    jobDescriptions.set(jobId, description);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = Object.fromEntries([...jobDescriptions.entries()].map(([k, v]) => [String(k), v]));
    fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(data, null, 2));
}

// Pending TonConnect create (waiting for user to confirm in Tonkeeper)
const pendingCreate = new Map<number, { budgetTon: string; description: string }>();
// Chat IDs for pending TonConnect users (for auto-notifications)
const pendingChats = new Map<number, number>();
// Active polling watchers for TonConnect operations
const tcWatchers = new Map<number, ReturnType<typeof setInterval>>();
// Last known factory job count (for detecting new jobs)
let lastKnownJobId = -1;

// In-memory storage adapter for TonConnect
class MemStorage implements IStorage {
    private data = new Map<string, string>();
    async getItem(key: string) { return this.data.get(key) ?? null; }
    async setItem(key: string, value: string) { this.data.set(key, value); }
    async removeItem(key: string) { this.data.delete(key); }
}

function getConnector(userId: number): TonConnect {
    let tc = userConnectors.get(userId);
    if (!tc) {
        tc = new TonConnect({ manifestUrl: MANIFEST_URL, storage: new MemStorage() });
        userConnectors.set(userId, tc);
    }
    return tc;
}

/** Check if user has any wallet (mnemonic or TonConnect) */
function hasWallet(userId: number): boolean {
    return userWallets.has(userId) || userTcAddresses.has(userId);
}

/** Get wallet mode: 'mnemonic' | 'tonconnect' | null */
function walletMode(userId: number): 'mnemonic' | 'tonconnect' | null {
    if (userWallets.has(userId)) return 'mnemonic';
    if (userTcAddresses.has(userId)) return 'tonconnect';
    return null;
}

// ─── Custom emoji cache ───
// Maps fallback emoji → custom_emoji_id
const ce: Record<string, string> = {};
let enactLogoId = '';

async function loadCustomEmoji() {
    try {
        const sets = ['TONEmoji', 'FinanceEmoji', 'EnactProtocol'];
        for (const name of sets) {
            try {
                const set = await bot.api.getStickerSet(name);
                for (const s of set.stickers) {
                    if (s.custom_emoji_id && s.emoji) {
                        ce[s.emoji] = s.custom_emoji_id;
                        // EnactProtocol pack has the project logo
                        if (name === 'EnactProtocol') {
                            enactLogoId = s.custom_emoji_id;
                        }
                    }
                }
            } catch { /* pack not found */ }
        }
        // Override specific emoji with exact IDs
        ce['💎'] = '5377620962390857342'; // TON payment factory
        ce['💵'] = '5197434882321567830'; // USDT payment factory
        ce['📄'] = '5444856076954520455'; // Description
        ce['🔗'] = '5224450179368767019'; // Network

        console.log(`Loaded ${Object.keys(ce).length} custom emoji, logo: ${enactLogoId ? 'yes' : 'no'}`);
    } catch {
        console.log('Custom emoji not available, using standard');
    }
}

// Named emoji IDs for specific contexts
const EID = {
    tonCoin: '5773773228057038336',
    forClients: '5332724926216428039',
    forProviders: '5197371802136892976',
    timeout: '5382194935057372936',
    browseJobs: '5197269100878907942',
};

/** Custom emoji by ID */
function eid(id: string, fallback: string): string {
    return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

/** Custom emoji for message text (HTML) — renders animated/static custom emoji */
function e(emoji: string): string {
    const id = ce[emoji];
    if (id) return `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
    return emoji;
}

/** TON currency display: bold amount + TON emoji */
function ton(value: string): string {
    return `<b>${value}</b> ${eid(EID.tonCoin, '💎')}`;
}

/** ENACT logo custom emoji for messages */
function logo(): string {
    if (enactLogoId) return `<tg-emoji emoji-id="${enactLogoId}">⚙️</tg-emoji>`;
    return '⚙️';
}

// ─── Helpers ───

// ─── Description/result decoding ───
function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PINATA_GW = 'https://green-known-basilisk-878.mypinata.cloud/ipfs';
const descCache = new Map<string, string>();

/** Upload text to IPFS via Pinata, return SHA-256 hash as BigInt */
async function uploadToIPFS(content: object): Promise<{ hash: string; hashBig: bigint }> {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) {
        // Fallback: hex encode (first 32 bytes)
        const text = JSON.stringify(content);
        const hex = Buffer.from(text).toString('hex').padEnd(64, '0').slice(0, 64);
        return { hash: hex, hashBig: BigInt('0x' + hex) };
    }
    const { createHash } = await import('crypto');
    const json = JSON.stringify(content);
    const hash = createHash('sha256').update(json, 'utf-8').digest('hex');
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({
            pinataContent: content,
            pinataMetadata: { name: `enact-${hash.slice(0, 8)}`, keyvalues: { descHash: hash } },
        }),
    });
    if (!res.ok) throw new Error(`IPFS upload failed: ${res.status}`);
    return { hash, hashBig: BigInt('0x' + hash) };
}

/** Decode hex-encoded text (sync, no IPFS) */
function decodeHexOnly(hash: string): string | null {
    if (!hash || hash === '0'.repeat(64)) return null;
    try {
        const clean = hash.replace(/0+$/, '');
        if (clean.length < 2) return null;
        const text = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
        if (/^[\x20-\x7E]+$/.test(text) && text.length > 1) return escapeHtml(text);
    } catch {}
    return null;
}

/** Find IPFS CID for a hash via Pinata metadata search */
async function findCID(hash: string): Promise<string | null> {
    if (!hash || hash === '0'.repeat(64)) return null;
    const jwt = process.env.PINATA_JWT;
    if (!jwt) return null;
    try {
        const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${jwt}` }, signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
            if (pins.rows?.length > 0) return pins.rows[0].ipfs_pin_hash;
        }
    } catch {}
    return null;
}

async function decodeDesc(hash: string): Promise<string | null> {
    if (!hash || hash === '0'.repeat(64)) return null;
    if (descCache.has(hash)) return descCache.get(hash)!;
    try {
        // Try 1: hex-encoded text (bot creates these)
        const clean = hash.replace(/0+$/, '');
        if (clean.length >= 2) {
            const text = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
            if (/^[\x20-\x7E]+$/.test(text) && text.length > 2) {
                const result = escapeHtml(text);
                descCache.set(hash, result);
                return result;
            }
        }
        // Try 2: Pinata metadata search (MCP tags uploads with descHash)
        const jwt = process.env.PINATA_JWT;
        if (jwt) {
            const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${jwt}` },
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
                if (pins.rows?.length > 0) {
                    const cid = pins.rows[0].ipfs_pin_hash;
                    const ipfsRes = await fetch(`${PINATA_GW}/${cid}`, { signal: AbortSignal.timeout(5000) });
                    if (ipfsRes.ok) {
                        const data = await ipfsRes.json();
                        const content = data.description ?? data.result ?? null;
                        if (content) {
                            const result = escapeHtml(String(content).slice(0, 200));
                            descCache.set(hash, result);
                            return result;
                        }
                    }
                }
            }
        }
    } catch {}
    return null;
}

function getUserId(ctx: any): number {
    return ctx.from?.id ?? 0;
}

/** Reply or edit: if triggered by callback (button click), edit the message. Otherwise send new. */
async function respond(ctx: any, text: string, opts: any = {}) {
    const o = { parse_mode: 'HTML' as const, ...opts };
    if (ctx.callbackQuery) {
        try { return await ctx.editMessageText(text, o); } catch {}
    }
    return ctx.reply(text, o);
}

/** Parse job arg: "0" → {id:0, jetton:false}, "j0" → {id:0, jetton:true} */
function parseJobArg(arg: string): { id: number; jetton: boolean } | null {
    if (arg.toLowerCase().startsWith('j')) {
        const id = parseInt(arg.slice(1));
        return isNaN(id) ? null : { id, jetton: true };
    }
    const id = parseInt(arg);
    return isNaN(id) ? null : { id, jetton: false };
}

/** Get user's wallet address (TonConnect or mnemonic), UQ format */
async function getUserAddr(userId: number): Promise<string> {
    const tc = userTcAddresses.get(userId);
    if (tc) return tc;
    const mn = userWallets.get(userId);
    if (mn) {
        const client = await createClient();
        const w = await createWalletFromMnemonic(client, mn);
        return w.wallet.address.toString({ bounceable: false });
    }
    return '';
}

async function requireWallet(ctx: any) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);

    if (!mode) {
        const kb = new InlineKeyboard()
            .text('👛 Connect Wallet', 'menu_connect');
        await ctx.reply(
            `${e('⚠️')} <b>Wallet not connected</b>\n\n` +
            `Connect your wallet first to perform transactions.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
        return null;
    }

    if (mode === 'mnemonic') {
        const client = await createClient();
        return createWalletFromMnemonic(client, userWallets.get(userId)!);
    }

    // TonConnect mode — return null, transactions go via deeplinks
    return null;
}

/** Build a ton:// deeplink for a transaction */
function tonTransferLink(to: string, amount: bigint, payload?: Cell): string {
    let link = `https://app.tonkeeper.com/transfer/${to}?amount=${amount}`;
    if (payload) {
        link += `&bin=${payload.toBoc().toString('base64url')}`;
    }
    return link;
}

/** Check if user is in TonConnect mode (transactions via deeplinks) */
function isTonConnect(userId: number): boolean {
    return walletMode(userId) === 'tonconnect';
}

// ────────────────────────────────────────────
// /start — Main menu
// ────────────────────────────────────────────
bot.command('start', async (ctx) => {
    const userId = getUserId(ctx);
    const connected = hasWallet(userId);

    const kb = new InlineKeyboard()
        .text('✍️ Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('🔭 Job Status', 'menu_status')
        .text('⚖️ Evaluate', 'menu_evaluate').row()
        .text('👛 Wallet', 'menu_wallet')
        .text('📊 Factories', 'menu_factory').row()
        .text('❓ Help', 'menu_help');

    await ctx.reply(
        `${logo()} <b>ENACT Protocol</b>\n\n` +
        `Trustless escrow for AI agent jobs on TON.\n\n` +
        `${e('👛')} Wallet: ${connected ? '<b>Connected</b>' : '<i>Not connected</i>'}\n` +
        `${e('🔗')} Network: TON Mainnet\n\n` +
        `Choose an action:`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

// ────────────────────────────────────────────
// Menu callbacks
// ────────────────────────────────────────────
bot.callbackQuery('menu_main', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);
    const connected = hasWallet(userId);

    const kb = new InlineKeyboard()
        .text('✍️ Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('🔭 Job Status', 'menu_status')
        .text('⚖️ Evaluate', 'menu_evaluate').row()
        .text('👛 Wallet', 'menu_wallet')
        .text('📊 Factories', 'menu_factory').row()
        .text('❓ Help', 'menu_help');

    await respond(ctx,
        `${logo()} <b>ENACT Protocol</b>\n\n` +
        `Trustless escrow for AI agent jobs on TON.\n\n` +
        `${e('👛')} Wallet: ${connected ? '<b>Connected</b>' : '<i>Not connected</i>'}\n` +
        `${e('🔗')} Network: TON Mainnet\n\n` +
        `Choose an action:`,
        { reply_markup: kb }
    );
});

bot.callbackQuery('menu_create', async (ctx) => {
    await ctx.answerCallbackQuery();
    await respond(ctx,
        `${e('✍️')} <b>Create a Job</b>\n\n` +
        `${e('💎')} <b>TON:</b>\n` +
        `<code>/create {amount} {description} {evaluator?}</code>\n\n` +
        `${e('💵')} <b>USDT:</b>\n` +
        `<code>/createjetton {amount} {description} {evaluator?}</code>\n\n` +
        `${e('💡')} <b>evaluator?</b> — optional, defaults to you.\n` +
        `Use <b>ai</b> for AI auto-evaluation, or a TON address for custom evaluator.`,
        { reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
});

bot.callbackQuery('menu_jobs', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleJobs(ctx, 0, 'all');
});

bot.callbackQuery('menu_status', async (ctx) => {
    await ctx.answerCallbackQuery();
    await respond(ctx,
        `${e('🔭')} <b>Check Job Status</b>\n\n` +
        `Send the command:\n` +
        `<code>/status job_id</code>\n\n` +
        `Example: <code>/status 0</code> (TON) or <code>/status j0</code> (USDT)`,
        { reply_markup: new InlineKeyboard().text('📋 Browse Jobs', 'menu_jobs').text('🏠 Menu', 'menu_main') }
    );
});

bot.callbackQuery('menu_wallet', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleWallet(ctx);
});

bot.callbackQuery('menu_connect', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);

    // Generate TonConnect link
    const connector = getConnector(userId);
    let tcLink = '';
    try {
        const url = await connector.connect({ universalLink: 'https://app.tonkeeper.com/ton-connect', bridgeUrl: 'https://bridge.tonapi.io/bridge' });
        if (typeof url === 'string') tcLink = url;
    } catch { /* ignore */ }

    // Listen for connection
    connector.onStatusChange(async (wallet) => {
        if (wallet) {
            const addr = Address.parseRaw(wallet.account.address).toString({ bounceable: false });
            userTcAddresses.set(userId, addr);
            saveWallets();
            try {
                await bot.api.sendMessage(ctx.chat!.id,
                    `${e('✅')} <b>Wallet Connected via TonConnect!</b>\n\n` +
                    `${e('📍')} Address:\n<code>${addr}</code>\n\n` +
                    `${e('🪙')} Transactions will open in Tonkeeper for approval.`,
                    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🏠 Main Menu', 'menu_main') }
                );
            } catch { /* chat may be unavailable */ }
        }
    });

    const kb = new InlineKeyboard();
    if (tcLink) {
        kb.url('👛 Connect via Tonkeeper', tcLink).row();
    }
    kb.text('🔑 Connect via Mnemonic', 'menu_connect_mnemonic').row()
      .text('🏠 Main Menu', 'menu_main');

    await ctx.reply(
        `${e('👛')} <b>Connect Wallet</b>\n\n` +
        (tcLink
            ? `${e('✅')} <b>Recommended:</b> Connect via Tonkeeper — safe, no secrets shared.\n\n`
            : '') +
        `${e('🔑')} <b>Advanced:</b> Connect via 24-word mnemonic for direct on-chain transactions.`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

bot.callbackQuery('menu_connect_mnemonic', async (ctx) => {
    await ctx.answerCallbackQuery();
    await respond(ctx,
        `${e('🔑')} <b>Connect via Mnemonic</b>\n\n` +
        `Send your 24-word mnemonic phrase:\n` +
        `<code>/connect word1 word2 ... word24</code>\n\n` +
        `${e('🔒')} Your mnemonic is stored encrypted on the server.\n` +
        `${e('⚠️')} Send this in a <b>private chat</b> with the bot for security.`,
        { reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
});

bot.callbackQuery('menu_factory', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleFactory(ctx);
});

bot.callbackQuery('menu_evaluate', async (ctx) => {
    await ctx.answerCallbackQuery();
    await respond(ctx,
        `${e('⚖️')} <b>Evaluate a Job</b>\n\n` +
        `Send the command:\n` +
        `<code>/evaluate job_id</code>\n\n` +
        `Example: <code>/evaluate 0</code>\n\n` +
        `${e('💡')} You must be the evaluator of the job. The bot will show the submitted result and let you approve or reject.`,
        { reply_markup: new InlineKeyboard().text('📋 Browse Jobs', 'menu_jobs').text('🏠 Menu', 'menu_main') }
    );
});

bot.callbackQuery('menu_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHelp(ctx);
});

bot.callbackQuery('menu_disconnect', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);
    userWallets.delete(userId);
    userTcAddresses.delete(userId);
    const tc = userConnectors.get(userId);
    if (tc) { try { await tc.disconnect(); } catch {} }
    userConnectors.delete(userId);
    saveWallets();
    await respond(ctx,
        `${e('✅')} Wallet disconnected.`,
        { reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
});

bot.callbackQuery('check_created', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);
    const pending = pendingCreate.get(userId);
    if (!pending) {
        return respond(ctx, `${e('❌')} No pending job creation found.`);
    }
    try {
        const client = await createClient();
        const jobCount = await getFactoryJobCount(client, FACTORY_ADDRESS);
        const jobId = jobCount - 1;
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);

        // Save description
        saveDescription(jobId, pending.description);
        pendingCreate.delete(userId);

        // Build fund deeplink for TonConnect
        const fundBody = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        const fundAmount = toNano(pending.budgetTon) + toNano('0.01');
        const fundLink = tonTransferLink(jobAddr.toString(), fundAmount, fundBody);

        const kb = new InlineKeyboard()
            .url(`🪙 Step 2: Fund ${pending.budgetTon} TON`, fundLink).row()
            .text('🔭 Status', `status_${jobId}`)
            .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
            .text('🏠 Main Menu', 'menu_main');

        await respond(ctx,
            `${e('✅')} <b>Job Created!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('🪙')} Budget: ${ton(pending.budgetTon)}\n` +
            `${e('📄')} Description: ${pending.description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `Now press <b>"Fund"</b> to deposit ${ton(pending.budgetTon)} into escrow.`,
            { reply_markup: kb }
        );
    } catch (err: any) {
        await respond(ctx,
            `${e('⏳')} Job not found on-chain yet. Wait ~10 seconds and try again.\n\n` +
            `${e('💡')} Press "Check if Created" again after Tonkeeper confirms.`,
            { reply_markup: new InlineKeyboard().text('🔄 Check Again', 'check_created').row().text('🏠 Menu', 'menu_main') }
        );
    }
});

// ────────────────────────────────────────────
// Action callbacks (from job status buttons)
// ────────────────────────────────────────────
bot.callbackQuery(/^fund_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleFund(ctx, jobId);
});

bot.callbackQuery(/^take_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleTake(ctx, jobId);
});

bot.callbackQuery(/^cancel_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleCancel(ctx, jobId);
});

bot.callbackQuery(/^claim_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleClaim(ctx, jobId);
});

bot.callbackQuery(/^quit_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleQuit(ctx, jobId);
});

bot.callbackQuery(/^status_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleStatus(ctx, jobId);
});

bot.callbackQuery(/^submit_prompt_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await respond(ctx,
        `${e('📨')} <b>Submit Result for Job #${jobId}</b>\n\n` +
        `Send:\n<code>/submit ${jobId} your result text here</code>`
    );
});

bot.callbackQuery(/^approve_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleEvaluate(ctx, jobId, true);
});

bot.callbackQuery(/^reject_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleEvaluate(ctx, jobId, false);
});

// Jetton job action callbacks
bot.callbackQuery(/^jfund_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleFund(ctx, parseInt(ctx.match![1]), JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^jtake_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleTake(ctx, parseInt(ctx.match![1]), JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^jcancel_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleCancel(ctx, parseInt(ctx.match![1]), JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^jclaim_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleClaim(ctx, parseInt(ctx.match![1]), JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^jquit_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleQuit(ctx, parseInt(ctx.match![1]), JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^japprove_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleEvaluate(ctx, parseInt(ctx.match![1]), true, JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^jreject_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await handleEvaluate(ctx, parseInt(ctx.match![1]), false, JETTON_FACTORY_ADDRESS); });
bot.callbackQuery(/^jsubmit_prompt_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await respond(ctx, `${e('📨')} <b>Submit Result for Jetton Job #${jobId}</b>\n\nSend:\n<code>/submit j${jobId} your result text here</code>`);
});

// ────────────────────────────────────────────
// Text commands
// ────────────────────────────────────────────
bot.command('help', async (ctx) => showHelp(ctx));
bot.command('wallet', async (ctx) => handleWallet(ctx));
bot.command('factory', async (ctx) => handleFactory(ctx));

bot.command('connect', async (ctx) => {
    const words = ctx.message?.text?.split(' ').slice(1) ?? [];

    // Try to delete the message containing the mnemonic for security
    try { await ctx.deleteMessage(); } catch { /* may lack permissions */ }

    if (words.length !== 24) {
        return ctx.reply(
            `${e('❌')} <b>Invalid mnemonic</b>\n\n` +
            `Please provide exactly 24 words:\n` +
            `<code>/connect word1 word2 ... word24</code>`,
            { parse_mode: 'HTML' }
        );
    }

    try {
        const client = await createClient();
        const w = await createWalletFromMnemonic(client, words);
        const addr = w.wallet.address.toString({ bounceable: false });
        const balance = await client.getBalance(w.wallet.address);

        const userId = getUserId(ctx);
        userWallets.set(userId, words);
        saveWallets();

        const kb = new InlineKeyboard()
            .url('🔗 Explorer', explorerLink(addr)).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `${e('✅')} <b>Wallet Connected!</b>\n\n` +
            `${e('📍')} Address:\n<code>${addr}</code>\n\n` +
            `${e('🪙')} Balance: ${ton((Number(balance) / 1e9).toFixed(2))}\n\n` +
            `${e('🔒')} Your mnemonic is stored encrypted on the server.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(
            `${e('❌')} <b>Invalid mnemonic</b>\n\n${err.message}`,
            { parse_mode: 'HTML' }
        );
    }
});

bot.command('disconnect', async (ctx) => {
    const userId = getUserId(ctx);
    userWallets.delete(userId);
    userTcAddresses.delete(userId);
    const tc = userConnectors.get(userId);
    if (tc) { try { await tc.disconnect(); } catch {} }
    userConnectors.delete(userId);
    saveWallets();
    await ctx.reply(
        `${e('✅')} Wallet disconnected.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
});

bot.command('create', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `${e('✍️')} <b>Create a Job</b>\n\n` +
            `Usage:\n<code>/create {amount} {description}</code>\n` +
            `<code>/create {amount} {description} ai</code>\n` +
            `<code>/create {amount} {description} {evaluator_address}</code>\n\n` +
            `${e('💡')} Evaluator: defaults to you. Use <b>ai</b> for AI auto-evaluation.`,
            { parse_mode: 'HTML' }
        );
    }

    const budgetTon = args[0];
    if (isNaN(Number(budgetTon)) || Number(budgetTon) <= 0) {
        return ctx.reply(`${e('❌')} Budget must be a positive number in TON.`, { parse_mode: 'HTML' });
    }

    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    const AI_EVALUATOR = 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu';
    const lastArg = args[args.length - 1];
    const isAI = lastArg.toLowerCase() === 'ai' && args.length >= 3;
    const isEvalAddr = !isAI && lastArg.length > 40 && (lastArg.startsWith('EQ') || lastArg.startsWith('UQ') || lastArg.startsWith('0:'));
    let evaluatorStr = '';
    let descArgs: string[];
    if (isAI) {
        evaluatorStr = AI_EVALUATOR;
        descArgs = args.slice(1, -1);
    } else if (isEvalAddr && args.length >= 3) {
        evaluatorStr = lastArg;
        descArgs = args.slice(1, -1);
    } else {
        descArgs = args.slice(1);
    }
    const description = descArgs.join(' ');

    try {
        const { hashBig: descHash } = await uploadToIPFS({ type: 'job_description', description, createdAt: new Date().toISOString() });
        const client = await createClient();

        if (mode === 'tonconnect') {
            const addr = userTcAddresses.get(userId)!;
            const evaluatorAddr = evaluatorStr ? Address.parse(evaluatorStr) : Address.parse(addr);
            const createBody = beginCell()
                .storeUint(FactoryOpcodes.createJob, 32)
                .storeAddress(evaluatorAddr)
                .storeCoins(toNano(budgetTon))
                .storeUint(descHash, 256)
                .storeUint(86400, 32)
                .storeUint(86400, 32)
                .endCell();

            // Pre-compute the job address so we can show both deeplinks at once
            const nextIdResult = await client.runMethod(Address.parse(FACTORY_ADDRESS), 'get_next_job_id');
            const predictedJobId = nextIdResult.stack.readNumber();
            const addrResult = await client.runMethod(Address.parse(FACTORY_ADDRESS), 'get_job_address', [
                { type: 'int', value: BigInt(predictedJobId) },
            ]);
            const predictedJobAddr = addrResult.stack.readAddress();

            const fundBody = beginCell().storeUint(JobOpcodes.fund, 32).endCell();

            const createLink = tonTransferLink(FACTORY_ADDRESS, toNano('0.03'), createBody);
            const fundLink = tonTransferLink(predictedJobAddr.toString(), toNano(budgetTon) + toNano('0.01'), fundBody);

            pendingCreate.set(userId, { budgetTon, description });
            pendingChats.set(userId, ctx.chat!.id);

            const kb = new InlineKeyboard()
                .url('1️⃣ Create Job', createLink).row()
                .url(`2️⃣ Fund ${budgetTon} TON`, fundLink).row()
                .text('🔄 Check Manually', 'check_created').row()
                .text('🏠 Main Menu', 'menu_main');

            const tonEvalLabel = evaluatorStr === AI_EVALUATOR ? '🤖 AI Evaluator' : evaluatorAddr.toString({ bounceable: false }).slice(0, 12) + '...';
            return ctx.reply(
                `${e('✍️')} <b>Create & Fund Job</b>\n\n` +
                `${e('🪙')} Budget: ${ton(budgetTon)}\n` +
                `${e('📄')} Description: ${description}\n` +
                `${e('⚖️')} Evaluator: ${tonEvalLabel}\n\n` +
                `Approve <b>both</b> transactions in Tonkeeper:\n` +
                `1️⃣ Create job (~0.03 ${eid(EID.tonCoin, '💎')} gas)\n` +
                `2️⃣ Fund with ${ton(budgetTon)}\n\n` +
                `${e('💡')} Wait ~10s between approvals.` +
                (evaluatorStr === AI_EVALUATOR ? `\n\n${e('🤖')} AI Evaluator will review this job.` : ''),
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }

        const w = await requireWallet(ctx);
        if (!w) return;

        await ctx.reply(`${e('⏳')} Creating and funding job...`, { parse_mode: 'HTML' });

        // Step 1: Create job
        const mnemonicEvaluator = evaluatorStr ? Address.parse(evaluatorStr) : w.wallet.address;
        const createBody = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(mnemonicEvaluator)
            .storeCoins(toNano(budgetTon))
            .storeUint(descHash, 256)
            .storeUint(86400, 32)
            .storeUint(86400, 32)
            .endCell();

        await sendTx(client, w, Address.parse(FACTORY_ADDRESS), toNano('0.03'), createBody);
        await new Promise(r => setTimeout(r, 10000));

        const jobCount = await getFactoryJobCount(client, FACTORY_ADDRESS);
        const jobId = jobCount - 1;
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);

        // Step 2: Auto-fund
        const fundBody = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        await sendTx(client, w, jobAddr, toNano(budgetTon) + toNano('0.01'), fundBody);
        await new Promise(r => setTimeout(r, 10000));

        saveDescription(jobId, description);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `${e('✅')} <b>Job Created & Funded!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('🪙')} Budget: ${ton(budgetTon)}\n` +
            `${e('📄')} Description: ${description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `Job is ready — waiting for a provider to take it.` +
            (evaluatorStr === AI_EVALUATOR ? `\n\n${e('🤖')} AI Evaluator will review this job.` : ''),
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
});

bot.command('createjetton', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `${e('💵')} <b>Create a Jetton (USDT) Job</b>\n\n` +
            `Usage:\n<code>/createjetton {amount} {description}</code>\n\n` +
            `Example: <code>/createjetton 10 Audit smart contract</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const budgetTon = args[0];
    if (isNaN(Number(budgetTon)) || Number(budgetTon) <= 0) {
        return ctx.reply(`${e('❌')} Budget must be a positive number.`, { parse_mode: 'HTML' });
    }

    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    const AI_EVALUATOR = 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu';
    const lastArg = args[args.length - 1];
    const jIsAI = lastArg.toLowerCase() === 'ai' && args.length >= 3;
    const isEvalAddr = !jIsAI && lastArg.length > 40 && (lastArg.startsWith('EQ') || lastArg.startsWith('UQ') || lastArg.startsWith('0:'));
    let jEvaluatorStr = '';
    let jDescArgs: string[];
    if (jIsAI) {
        jEvaluatorStr = AI_EVALUATOR;
        jDescArgs = args.slice(1, -1);
    } else if (isEvalAddr && args.length >= 3) {
        jEvaluatorStr = lastArg;
        jDescArgs = args.slice(1, -1);
    } else {
        jDescArgs = args.slice(1);
    }
    const description = jDescArgs.join(' ');

    try {
        const { hashBig: descHash } = await uploadToIPFS({ type: 'job_description', description, createdAt: new Date().toISOString() });
        const client = await createClient();

        if (mode === 'tonconnect') {
            const addr = userTcAddresses.get(userId)!;
            const jettonEvaluator = jEvaluatorStr ? Address.parse(jEvaluatorStr) : Address.parse(addr);
            const usdtBudget = BigInt(Math.round(parseFloat(budgetTon) * 1e6)); // USDT: 6 decimals
            const createBody = beginCell()
                .storeUint(FactoryOpcodes.createJob, 32)
                .storeAddress(jettonEvaluator)
                .storeCoins(usdtBudget)
                .storeUint(descHash, 256)
                .storeUint(86400, 32)
                .storeUint(86400, 32)
                .endCell();

            const createLink = tonTransferLink(JETTON_FACTORY_ADDRESS, toNano('0.03'), createBody);

            // Pre-compute job address for fund deeplink
            const nextIdRes = await client.runMethod(Address.parse(JETTON_FACTORY_ADDRESS), 'get_next_job_id');
            const predictedId = nextIdRes.stack.readNumber();
            await new Promise(r => setTimeout(r, 1500));
            const predAddrRes = await client.runMethod(Address.parse(JETTON_FACTORY_ADDRESS), 'get_job_address', [{ type: 'int', value: BigInt(predictedId) }]);
            const predictedAddr = predAddrRes.stack.readAddress();

            // Step 2: Set USDT wallet deeplink
            const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
            await new Promise(r => setTimeout(r, 1500));
            const jobJwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(predictedAddr).endCell() }
            ]);
            const jobJw = jobJwRes.stack.readAddress();
            const setWalletBody = beginCell().storeUint(JobOpcodes.setJettonWallet, 32).storeAddress(jobJw).endCell();
            const setWalletLink = tonTransferLink(predictedAddr.toString(), toNano('0.01'), setWalletBody);

            // Step 3: Fund USDT deeplink
            await new Promise(r => setTimeout(r, 1500));
            const cjwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(Address.parse(addr)).endCell() }
            ]);
            const clientJw = cjwRes.stack.readAddress();
            const fundBody = beginCell()
                .storeUint(0x0f8a7ea5, 32).storeUint(0, 64)
                .storeCoins(usdtBudget)
                .storeAddress(predictedAddr).storeAddress(Address.parse(addr))
                .storeBit(false).storeCoins(toNano('0.05')).storeBit(false)
                .endCell();
            const fundLink = tonTransferLink(clientJw.toString(), toNano('0.1'), fundBody);

            pendingCreate.set(userId, { budgetTon, description });
            pendingChats.set(userId, ctx.chat!.id);

            const evalLabel = jEvaluatorStr === AI_EVALUATOR ? '🤖 AI Evaluator' : jettonEvaluator.toString({ bounceable: false }).slice(0, 12) + '...';

            const kb = new InlineKeyboard()
                .url('1️⃣ Create Job', createLink).row()
                .url('2️⃣ Set USDT Wallet', setWalletLink).row()
                .url(`3️⃣ Fund ${budgetTon} USDT`, fundLink).row()
                .text('🔄 Check Manually', 'check_created_jetton').row()
                .text('🏠 Main Menu', 'menu_main');

            return ctx.reply(
                `${e('💵')} <b>Create Jetton Job</b>\n\n` +
                `${e('🪙')} Budget: <b>${budgetTon}</b> USDT\n` +
                `${e('📄')} Description: ${description}\n` +
                `${e('⚖️')} Evaluator: ${evalLabel}\n\n` +
                `Approve <b>all 3</b> transactions in Tonkeeper:\n` +
                `1️⃣ Create job (~0.03 TON gas)\n` +
                `2️⃣ Set USDT wallet (~0.01 TON gas)\n` +
                `3️⃣ Fund with ${budgetTon} USDT\n\n` +
                `${e('💡')} Wait ~15s between each approval.` +
                (jEvaluatorStr === AI_EVALUATOR ? `\n\n${e('🤖')} AI Evaluator will review this job.` : ''),
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }

        const w = await requireWallet(ctx);
        if (!w) return;

        await ctx.reply(`${e('⏳')} Creating Jetton job...`, { parse_mode: 'HTML' });

        const usdtBudget = BigInt(Math.round(parseFloat(budgetTon) * 1e6)); // USDT: 6 decimals
        const jMnemonicEval = jEvaluatorStr ? Address.parse(jEvaluatorStr) : w.wallet.address;
        const createBody = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(jMnemonicEval)
            .storeCoins(usdtBudget)
            .storeUint(descHash, 256)
            .storeUint(86400, 32)
            .storeUint(86400, 32)
            .endCell();

        await sendTx(client, w, Address.parse(JETTON_FACTORY_ADDRESS), toNano('0.03'), createBody);
        await new Promise(r => setTimeout(r, 10000));

        const jobCount = await getFactoryJobCount(client, JETTON_FACTORY_ADDRESS);
        const jobId = jobCount - 1;
        const jobAddr = await getJobAddress(client, JETTON_FACTORY_ADDRESS, jobId);

        // Auto set USDT jetton wallet
        const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
        const jwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(jobAddr).endCell() },
        ]);
        const jobUsdtWallet = jwRes.stack.readAddress();
        const setJwBody = beginCell().storeUint(JobOpcodes.setJettonWallet, 32).storeAddress(jobUsdtWallet).endCell();
        await sendTx(client, w, jobAddr, toNano('0.01'), setJwBody);
        await new Promise(r => setTimeout(r, 5000));

        saveDescription(jobId + 100000, description);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `jstatus_${jobId}`)
            .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `${e('✅')} <b>Jetton Job Created!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('💵')} Budget: <b>${budgetTon}</b> USDT\n` +
            `${e('📄')} Description: ${description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `USDT wallet set. Use <code>/fund j${jobId}</code> to fund with USDT.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
});

bot.callbackQuery('check_created_jetton', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);
    const pending = pendingCreate.get(userId);
    if (!pending) {
        return respond(ctx, `${e('❌')} No pending job creation found.`);
    }
    try {
        const client = await createClient();
        const jobCount = await getFactoryJobCount(client, JETTON_FACTORY_ADDRESS);
        const jobId = jobCount - 1;
        const jobAddr = await getJobAddress(client, JETTON_FACTORY_ADDRESS, jobId);

        saveDescription(jobId + 100000, pending.description);
        pendingCreate.delete(userId);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `jstatus_${jobId}`)
            .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
            .text('🏠 Main Menu', 'menu_main');

        await respond(ctx,
            `${e('✅')} <b>Jetton Job Created!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('💵')} Budget: <b>${pending.budgetTon}</b> USDT\n` +
            `${e('📄')} Description: ${pending.description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `USDT wallet set. Ready to fund.`,
            { reply_markup: kb }
        );
    } catch (err: any) {
        await respond(ctx,
            `${e('⏳')} Job not found yet. Wait ~10 seconds and try again.`,
            { reply_markup: new InlineKeyboard().text('🔄 Check Again', 'check_created_jetton').row().text('🏠 Menu', 'menu_main') }
        );
    }
});

bot.callbackQuery(/^jstatus_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleJettonStatus(ctx, jobId);
});

bot.command('fund', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/fund 0</code> or <code>/fund j0</code>`, { parse_mode: 'HTML' });
    await handleFund(ctx, parsed.id, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('take', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/take 0</code> or <code>/take j0</code>`, { parse_mode: 'HTML' });
    await handleTake(ctx, parsed.id, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('submit', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `${e('❌')} <b>Invalid format</b>\n\nUsage:\n<code>/submit job_id result_text</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    const parsed = parseJobArg(args[0]);
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/submit 0 result</code> or <code>/submit j0 result</code>`, { parse_mode: 'HTML' });
    const jobId = parsed.id;
    const factory = parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS;
    const resultText = args.slice(1).join(' ');

    // Verify job exists, state=FUNDED, and caller is the provider
    try {
        const client = await createClient();
        const count = await getFactoryJobCount(client, factory);
        if (jobId >= count) {
            return ctx.reply(`${e('❌')} Job ${parsed.jetton ? 'J#' : '#'}${jobId} does not exist.`, { parse_mode: 'HTML' });
        }
        const jobAddr = await getJobAddress(client, factory, jobId);
        const status = await getJobStatus(client, jobAddr.toString());
        if (status.stateName !== 'FUNDED') {
            return ctx.reply(`${e('❌')} Job is in <b>${status.stateName}</b> state, cannot submit.`, { parse_mode: 'HTML' });
        }
        if (status.provider === 'none') {
            return ctx.reply(`${e('❌')} No provider assigned to this job yet.`, { parse_mode: 'HTML' });
        }
        // Check wallet matches provider
        const userAddr = await getUserAddr(userId);
        if (userAddr && status.provider !== userAddr) {
            return ctx.reply(`${e('❌')} You are not the provider of this job.`, { parse_mode: 'HTML' });
        }
    } catch (err: any) {
        return ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }

    try {
        const { hashBig: resultHash } = await uploadToIPFS({ type: 'job_result', result: resultText, submittedAt: new Date().toISOString() });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.submitResult, 32)
            .storeUint(resultHash, 256)
            .storeUint(2, 8) // result_type = 2 (IPFS)
            .endCell();

        const statusCb = parsed.jetton ? `jstatus_${jobId}` : `status_${jobId}`;
        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Submit in Tonkeeper', link).row()
                .text('🔭 Status', statusCb)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(
                `${e('📨')} <b>Submit Result for Job #${jobId}</b>\n\n` +
                `Open Tonkeeper to approve.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 2); // 2=SUBMITTED
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} Submitting result...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', statusCb)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('📨')} <b>Result Submitted!</b>\n\n` +
            `${e('🆔')} Job: #${jobId}\n` +
            `Awaiting evaluation from the evaluator.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );

        // Notify evaluator if connected to bot
        try {
            const status = await getJobStatus(client, jobAddr.toString());
            const desc = jobDescriptions.get(jobId) ?? await decodeDesc(status.descHash) ?? '';
            // Check all connected wallets (TonConnect + mnemonic)
            const allUsers = new Map<number, string>();
            for (const [uid, addr] of userTcAddresses) allUsers.set(uid, addr);
            for (const [uid] of userWallets) {
                if (!allUsers.has(uid)) {
                    try { allUsers.set(uid, await getUserAddr(uid)); } catch {}
                }
            }
            for (const [uid, addr] of allUsers) {
                if (addr === status.evaluator) {
                    const evalKb = new InlineKeyboard()
                        .text('✅ Approve', `approve_${jobId}`)
                        .text('❌ Reject', `reject_${jobId}`).row()
                        .text('🔭 View Job', `status_${jobId}`);
                    await bot.api.sendMessage(uid,
                        `${e('⚖️')} <b>Job #${jobId} — Evaluation Needed</b>\n\n` +
                        (desc ? `${e('📄')} <b>Description:</b>\n<blockquote>${desc.length > 120 ? desc.slice(0, 120) + '...' : desc}</blockquote>\n` : '') +
                        `${e('🪙')} Budget: ${ton(fmtTon(status.budget))}\n` +
                        `${eid(EID.forProviders, '🔧')} Provider: <code>${status.provider}</code>\n\n` +
                        `Please review and approve or reject.`,
                        { parse_mode: 'HTML', reply_markup: evalKb }
                    );
                    break;
                }
            }
        } catch {}
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
});

bot.command('approve', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/approve 0</code> or <code>/approve j0</code>`, { parse_mode: 'HTML' });
    await handleEvaluate(ctx, parsed.id, true, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('reject', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/reject 0</code> or <code>/reject j0</code>`, { parse_mode: 'HTML' });
    await handleEvaluate(ctx, parsed.id, false, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('budget', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) return ctx.reply(`${e('❌')} Usage: <code>/budget job_id amount_ton</code>`, { parse_mode: 'HTML' });

    const w = await requireWallet(ctx);
    if (!w) return;

    const jobId = parseInt(args[0]);
    const amountTon = args[1];

    try {
        await ctx.reply(`${e('⏳')} Updating budget...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.setBudget, 32)
            .storeCoins(toNano(amountTon))
            .endCell();
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard()
            .text('🪙 Fund Job', `fund_${jobId}`)
            .text('🔭 Status', `status_${jobId}`);

        await ctx.reply(
            `${e('✅')} Budget for job #${jobId} set to ${ton(amountTon)}`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
});

bot.command('cancel', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/cancel 0</code> or <code>/cancel j0</code>`, { parse_mode: 'HTML' });
    await handleCancel(ctx, parsed.id, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('claim', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/claim 0</code> or <code>/claim j0</code>`, { parse_mode: 'HTML' });
    await handleClaim(ctx, parsed.id, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('quit', async (ctx) => {
    const parsed = parseJobArg(ctx.message?.text?.split(' ')[1] ?? '');
    if (!parsed) return ctx.reply(`${e('❌')} Usage: <code>/quit 0</code> or <code>/quit j0</code>`, { parse_mode: 'HTML' });
    await handleQuit(ctx, parsed.id, parsed.jetton ? JETTON_FACTORY_ADDRESS : FACTORY_ADDRESS);
});

bot.command('status', async (ctx) => {
    const arg = ctx.message?.text?.split(' ')[1] ?? '';
    if (arg.toLowerCase().startsWith('j')) {
        const jobId = parseInt(arg.slice(1));
        if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/status j0</code> (USDT) or <code>/status 0</code> (TON)`, { parse_mode: 'HTML' });
        return handleJettonStatus(ctx, jobId);
    }
    const jobId = parseInt(arg);
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/status 0</code> (TON) or <code>/status j0</code> (USDT)`, { parse_mode: 'HTML' });
    await handleStatus(ctx, jobId);
});

bot.command('jobs', async (ctx) => handleJobs(ctx, 0, 'all'));

bot.callbackQuery(/^jobs_page_(\d+)_?(.*)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match![1]);
    const filter = ctx.match![2] || 'all';
    await handleJobs(ctx, page, filter);
});

bot.callbackQuery('noop', async (ctx) => { await ctx.answerCallbackQuery(); });

bot.callbackQuery(/^jobs_filter_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const filter = ctx.match![1];
    await handleJobs(ctx, 0, filter);
});

bot.command('evaluate', async (ctx) => {
    const arg = ctx.message?.text?.split(' ')[1] ?? '';
    if (!arg) {
        return ctx.reply(
            `${e('⚖️')} <b>Evaluate a Job</b>\n\n` +
            `Usage:\n<code>/evaluate 0</code> — TON job\n<code>/evaluate j0</code> — USDT job\n\n` +
            `Shows job details + result, then lets you approve or reject.`,
            { parse_mode: 'HTML' }
        );
    }
    if (arg.toLowerCase().startsWith('j')) {
        const jobId = parseInt(arg.slice(1));
        if (!isNaN(jobId)) return handleJettonStatus(ctx, jobId);
    }
    const jobId = parseInt(arg);
    if (!isNaN(jobId)) return handleStatus(ctx, jobId);
    return ctx.reply(`${e('❌')} Usage: <code>/evaluate 0</code> or <code>/evaluate j0</code>`, { parse_mode: 'HTML' });
});

// ────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────

async function handleWallet(ctx: any) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);

    if (!mode) {
        const kb = new InlineKeyboard()
            .text('👛 Connect Wallet', 'menu_connect').row()
            .text('🏠 Main Menu', 'menu_main');

        return respond(ctx,
            `${e('👛')} <b>Wallet</b>\n\n` +
            `${e('🚫')} No wallet connected.\n\n` +
            `Connect your wallet to create jobs, fund escrow, and interact with ENACT contracts.`,
            { reply_markup: kb }
        );
    }

    try {
        const client = await createClient();
        let addr: string;
        let balance: bigint;

        if (mode === 'mnemonic') {
            const w = await createWalletFromMnemonic(client, userWallets.get(userId)!);
            addr = w.wallet.address.toString({ bounceable: false });
            balance = await client.getBalance(w.wallet.address);
        } else {
            addr = userTcAddresses.get(userId)!;
            balance = await client.getBalance(Address.parse(addr));
        }

        const modeLabel = mode === 'tonconnect' ? 'TonConnect' : 'Mnemonic';

        const kb = new InlineKeyboard()
            .url('🔗 Explorer', explorerLink(addr))
            .text('🔌 Disconnect', 'menu_disconnect').row()
            .text('🏠 Main Menu', 'menu_main');

        await respond(ctx,
            `${e('👛')} <b>Your Wallet</b>\n\n` +
            `${e('📍')} Address:\n<code>${addr}</code>\n\n` +
            `${e('🪙')} Balance: ${ton((Number(balance) / 1e9).toFixed(2))}\n` +
            `${e('🔗')} Mode: <b>${modeLabel}</b>`,
            { reply_markup: kb }
        );
    } catch (err: any) {
        await respond(ctx, `${e('❌')} Error: ${err.message}`);
    }
}

async function handleFactory(ctx: any) {
    const kb = new InlineKeyboard()
        .url('💎 JobFactory', explorerLink(FACTORY_ADDRESS))
        .url('💵 JettonJobFactory', explorerLink(JETTON_FACTORY_ADDRESS)).row()
        .text('🏠 Main Menu', 'menu_main');

    await respond(ctx,
        `${logo()} <b>ENACT Factories</b>\n` +
        `${e('🔗')} TON Mainnet\n\n` +
        `${e('💎')} <b>JobFactory</b> (TON payments):\n` +
        `<code>${FACTORY_ADDRESS}</code>\n\n` +
        `${e('💵')} <b>JettonJobFactory</b> (USDT payments):\n` +
        `<code>${JETTON_FACTORY_ADDRESS}</code>`,
        { reply_markup: kb }
    );
}

async function handleJobs(ctx: any, page: number, filter: string) {
    const PAGE_SIZE = 5;
    const [statusF, typeF] = filter.includes('_') ? filter.split('_') : [filter === 'active' ? 'active' : 'all', filter === 'ton' ? 'ton' : filter === 'usdt' ? 'usdt' : 'all'];
    const activeOnly = statusF === 'active';
    const tonOnly = typeF === 'ton';
    const usdtOnly = typeF === 'usdt';
    const needsFilter = activeOnly || tonOnly || usdtOnly;
    try {
        const client = await createClient();
        const count = await getFactoryJobCount(client, FACTORY_ADDRESS);
        let jettonCount = 0;
        try { jettonCount = await getFactoryJobCount(client, JETTON_FACTORY_ADDRESS); } catch {}

        const total = count + jettonCount;
        if (total === 0) {
            const kb = new InlineKeyboard()
                .text('✍️ Create First Job', 'menu_create').row()
                .text('🏠 Main Menu', 'menu_main');
            return respond(ctx, `${e('📋')} No jobs yet. Create the first one!`, { reply_markup: kb });
        }

        const stateIcon: Record<string, string> = {
            OPEN: e('🟢'), FUNDED: e('💰'), SUBMITTED: e('📨'),
            COMPLETED: e('✅'), DISPUTED: e('⚠️'), CANCELLED: e('🚫'),
        };

        // Build job list: newest first (TON newest, then Jetton newest)
        // Only fetch the page we need — parallel requests
        type JobEntry = {id: number; type: string; state: string; budget: string; icon: string};

        async function fetchJob(factory: string, id: number, type: string): Promise<JobEntry | null> {
            try {
                const addr = await getJobAddress(client, factory, id);
                const s = await getJobStatus(client, addr.toString());
                if (activeOnly && s.stateName !== 'OPEN' && s.stateName !== 'FUNDED') return null;
                if (tonOnly && type !== 'ton') return null;
                if (usdtOnly && type !== 'jetton') return null;
                const budget = type === 'jetton' ? `<b>${fmtUsdt(s.budget)}</b> ${e('💵')}` : ton(fmtTon(s.budget));
                return { id, type, state: s.stateName, budget, icon: stateIcon[s.stateName] ?? '❓' };
            } catch { return null; }
        }

        // Build ordered index: newest first, filtered by type
        const allIds: Array<{factory: string; id: number; type: string}> = [];
        if (!usdtOnly) for (let i = count - 1; i >= 0; i--) allIds.push({ factory: FACTORY_ADDRESS, id: i, type: 'ton' });
        if (!tonOnly) for (let i = jettonCount - 1; i >= 0; i--) allIds.push({ factory: JETTON_FACTORY_ADDRESS, id: i, type: 'jetton' });
        // Interleave if showing both
        if (!tonOnly && !usdtOnly) {
            const mixed: typeof allIds = [];
            let ti2 = 0, ji2 = allIds.findIndex(x => x.type === 'jetton');
            if (ji2 === -1) ji2 = allIds.length;
            const tons = allIds.slice(0, ji2), jets = allIds.slice(ji2);
            let a = 0, b = 0;
            while (a < tons.length || b < jets.length) {
                if (b < jets.length) mixed.push(jets[b++]);
                if (a < tons.length) mixed.push(tons[a++]);
            }
            allIds.length = 0;
            allIds.push(...mixed);
        }

        // Active needs full scan, TON/USDT-only use page-only fetch
        let jobs: JobEntry[];
        if (activeOnly) {
            // Fetch all in parallel batches of 5
            const allJobs: (JobEntry | null)[] = [];
            for (let batch = 0; batch < allIds.length; batch += 5) {
                const chunk = allIds.slice(batch, batch + 5);
                const results = await Promise.all(chunk.map(j => fetchJob(j.factory, j.id, j.type)));
                allJobs.push(...results);
            }
            jobs = allJobs.filter(Boolean) as JobEntry[];
        } else {
            // Only fetch jobs for current page
            const pageIds = allIds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
            const results = await Promise.all(pageIds.map(j => fetchJob(j.factory, j.id, j.type)));
            jobs = results.filter(Boolean) as JobEntry[];
        }

        const totalForPages = needsFilter ? jobs.length : total;
        const totalPages = Math.ceil(totalForPages / PAGE_SIZE) || 1;
        const safePage = Math.min(page, totalPages - 1);
        const pageJobs = needsFilter ? jobs.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE) : jobs;

        const parts = [];
        if (activeOnly) parts.push('active');
        if (tonOnly) parts.push('TON');
        if (usdtOnly) parts.push('USDT');
        const filterLabel = parts.length > 0 ? ' ' + parts.join(' ') : ' total';
        let text = `${eid(EID.browseJobs, '📋')} <b>Jobs</b> (${needsFilter ? jobs.length : totalForPages}${filterLabel})`;
        if (totalPages > 1) text += ` — page ${safePage + 1}/${totalPages}`;
        text += '\n\n';

        for (const j of pageJobs) {
            const prefix = j.type === 'jetton' ? 'J#' : '#';
            text += `${j.icon} <b>${prefix}${j.id}</b> — ${j.state} | ${j.budget}\n`;
        }
        if (pageJobs.length === 0) text += '<i>No jobs match filter</i>\n';

        const kb = new InlineKeyboard();
        for (const j of pageJobs) {
            const cb = j.type === 'jetton' ? `jstatus_${j.id}` : `status_${j.id}`;
            const label = j.type === 'jetton' ? `💵 J#${j.id}` : `🔭 #${j.id}`;
            kb.text(label, cb);
        }
        kb.row();

        // Filter buttons — two groups: status (All/Active) + type (TON/USDT)
        // filter format: "status_type" e.g. "all_all", "active_ton", "all_usdt"
        const [statusF, typeF] = filter.includes('_') ? filter.split('_') : [filter === 'active' ? 'active' : 'all', filter === 'ton' ? 'ton' : filter === 'usdt' ? 'usdt' : 'all'];
        const mkFilter = (s: string, t: string) => `${s}_${t}`;
        kb.text(statusF === 'all' ? '✅ All' : '❌ All', `jobs_filter_${mkFilter('all', typeF)}`)
          .text(statusF === 'active' ? '✅ Active' : '❌ Active', `jobs_filter_${mkFilter('active', typeF)}`)
          .text(typeF === 'all' ? '✅ Both' : '❌ Both', `jobs_filter_${mkFilter(statusF, 'all')}`)
          .text(typeF === 'ton' ? '✅ TON' : '❌ TON', `jobs_filter_${mkFilter(statusF, 'ton')}`)
          .text(typeF === 'usdt' ? '✅ USDT' : '❌ USDT', `jobs_filter_${mkFilter(statusF, 'usdt')}`);
        kb.row();

        // Pagination
        const fullFilter = `${statusF}_${typeF}`;
        if (safePage < totalPages - 1) kb.text('⬅️ Older', `jobs_page_${safePage + 1}_${fullFilter}`);
        if (safePage > 0) kb.text('Newer ➡️', `jobs_page_${safePage - 1}_${fullFilter}`);
        if (totalPages > 1) kb.row();

        kb.text('✍️ Create Job', 'menu_create')
          .text('🏠 Menu', 'menu_main');

        await respond(ctx, text, { reply_markup: kb, link_preview_options: { is_disabled: true } });
    } catch (err: any) {
        await respond(ctx, `${e('❌')} Error: ${err.message}`);
    }
}

async function handleStatus(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const s = await getJobStatus(client, jobAddr.toString());

        const stateIcon: Record<string, string> = {
            OPEN: e('🟢'), FUNDED: e('💰'), SUBMITTED: e('📨'),
            COMPLETED: e('✅'), DISPUTED: e('⚠️'), CANCELLED: e('🚫'),
        };
        const icon = stateIcon[s.stateName] ?? '❓';

        const desc = jobDescriptions.get(jobId) ?? await decodeDesc(s.descHash);
        const resultText = (s.stateName === 'SUBMITTED' || s.stateName === 'COMPLETED' || s.stateName === 'DISPUTED') ? await decodeDesc(s.resultHash) : null;
        const reasonText = (s.stateName === 'COMPLETED' || s.stateName === 'DISPUTED') ? decodeHexOnly(s.reasonHash) : null;
        const descCid = desc ? await findCID(s.descHash) : null;
        const resCid = resultText ? await findCID(s.resultHash) : null;
        let text =
            `${icon} <b>Job #${s.jobId}</b>\n\n` +
            `${e('📊')} State: <b>${s.stateName}</b>\n` +
            `${e('🪙')} Budget: ${ton(fmtTon(s.budget))}\n` +
            (desc ? `\n${e('📄')} <b>Description:</b>\n<blockquote>${descCid ? `<a href="${PINATA_GW}/${descCid}">` : ''}${desc.length > 120 ? desc.slice(0, 120) + '...' : desc}${descCid ? '</a>' : ''}</blockquote>\n` : '') +
            (resultText ? `${e('📨')} <b>Result:</b>\n<blockquote>${resCid ? `<a href="${PINATA_GW}/${resCid}">` : ''}${resultText.length > 120 ? resultText.slice(0, 120) + '...' : resultText}${resCid ? '</a>' : ''}</blockquote>\n` : '') +
            (reasonText ? `${e('⚖️')} <b>Reason:</b> <i>${reasonText.length > 80 ? reasonText.slice(0, 80) + '...' : reasonText}</i>\n` : '') +
            `\n` +
            `${eid(EID.forClients, '👤')} Client: <code>${s.client}</code>\n` +
            `${eid(EID.forProviders, '🔧')} Provider: <code>${s.provider}</code>\n` +
            `${e('⚖️')} Evaluator: ${s.evaluator === 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu' ? '🤖 AI' : ''} <code>${s.evaluator}</code>\n` +
            `${eid(EID.timeout, '⏰')} Timeout: ${s.timeout / 3600}h${s.createdAt > 0 ? (() => { const left = (s.createdAt + s.timeout) - Math.floor(Date.now()/1000); return left > 0 ? ' | ' + Math.floor(left/3600) + 'h ' + Math.floor((left%3600)/60) + 'm left' : ' | expired'; })() : ''}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>`;

        const kb = new InlineKeyboard();

        // Show buttons based on user role
        const userAddr = await getUserAddr(userId);
        const isClient = userAddr && s.client === userAddr;
        const isProvider = userAddr && s.provider === userAddr;
        const isEvaluator = userAddr && s.evaluator === userAddr;

        switch (s.stateName) {
            case 'OPEN':
                if (isClient) kb.text('💰 Fund', `fund_${jobId}`);
                break;
            case 'FUNDED':
                if (s.provider === 'none') {
                    if (!isClient) kb.text('🤝 Take Job', `take_${jobId}`);
                } else if (isProvider) {
                    kb.text('📨 Submit Result', `submit_prompt_${jobId}`);
                    kb.text('🚪 Quit', `quit_${jobId}`);
                }
                if (isClient) kb.text('🚫 Cancel', `cancel_${jobId}`);
                break;
            case 'SUBMITTED':
                if (isEvaluator || isClient) {
                    kb.text('✅ Approve', `approve_${jobId}`)
                      .text('❌ Reject', `reject_${jobId}`).row();
                }
                if (isProvider) kb.text('⏰ Claim (timeout)', `claim_${jobId}`);
                break;
            case 'COMPLETED':
                text += `\n\n${e('🎉')} Job completed!`;
                break;
            case 'CANCELLED':
                text += `\n\n${e('🚫')} Job cancelled.`;
                break;
        }

        kb.row()
          .url('🔗 Explorer', explorerLink(jobAddr.toString()))
          .text('🏠 Menu', 'menu_main');

        await respond(ctx, text, { reply_markup: kb, link_preview_options: { is_disabled: true } });
    } catch (err: any) {
        await respond(ctx, `${e('❌')} Error: ${err.message}`);
    }
}

async function handleFund(ctx: any, jobId: number, factory = FACTORY_ADDRESS) {
    const isJetton = factory === JETTON_FACTORY_ADDRESS;
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const status = await getJobStatus(client, jobAddr.toString());
        const budgetDisplay = isJetton ? `<b>${fmtUsdt(status.budget)}</b> ${e('💵')}` : ton(fmtTon(status.budget));

        if (isJetton) {
            // Check if jettonWallet is set — if not, show setWallet deeplink first
            const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
            const expectedJwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(jobAddr).endCell() }
            ]);
            const expectedJw = expectedJwRes.stack.readAddress();

            // Read jettonWallet from contract (field 15 in get_job_data)
            const fullData = await client.runMethod(jobAddr, 'get_job_data');
            for (let i = 0; i < 14; i++) fullData.stack.pop(); // skip to field 15
            let currentJw: string;
            try { currentJw = fullData.stack.readAddress().toString(); } catch { currentJw = ''; }

            if (currentJw !== expectedJw.toString()) {
                // jettonWallet not set — show setWallet deeplink
                const setBody = beginCell().storeUint(JobOpcodes.setJettonWallet, 32).storeAddress(expectedJw).endCell();
                const setLink = tonTransferLink(jobAddr.toString(), toNano('0.01'), setBody);
                const kb = new InlineKeyboard()
                    .url('👛 Set USDT Wallet', setLink).row()
                    .text('🔭 Status', `jstatus_${jobId}`)
                    .text('🏠 Menu', 'menu_main');
                return ctx.reply(
                    `${e('⚠️')} <b>USDT wallet not set for Job J#${jobId}</b>\n\n` +
                    `Set the USDT wallet first, then fund.\n` +
                    `After approving, run <code>/fund j${jobId}</code> again.`,
                    { parse_mode: 'HTML', reply_markup: kb }
                );
            }
        }

        if (isJetton && mode === 'tonconnect') {
            // USDT fund: jetton transfer deeplink
            const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
            const addr = userTcAddresses.get(userId)!;
            const cjwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(Address.parse(addr)).endCell() }
            ]);
            const clientJw = cjwRes.stack.readAddress();
            const fundBody = beginCell()
                .storeUint(0x0f8a7ea5, 32).storeUint(0, 64)
                .storeCoins(status.budget)
                .storeAddress(jobAddr).storeAddress(Address.parse(addr))
                .storeBit(false).storeCoins(toNano('0.05')).storeBit(false)
                .endCell();
            const link = tonTransferLink(clientJw.toString(), toNano('0.1'), fundBody);
            const kb = new InlineKeyboard()
                .url('👛 Fund USDT in Tonkeeper', link).row()
                .text('🔭 Status', `jstatus_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(
                `${e('💰')} <b>Fund Jetton Job #${jobId}</b>\n\n` +
                `${e('💵')} Amount: ${budgetDisplay}\n\n` +
                `Open Tonkeeper to approve.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 1);
            return;
        }

        if (!isJetton && mode === 'tonconnect') {
            const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
            const amount = status.budget + toNano('0.01');
            const link = tonTransferLink(jobAddr.toString(), amount, body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', isJetton ? `jstatus_${jobId}` : `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(
                `${e('💰')} <b>Fund Job #${jobId}</b>\n\n` +
                `${e('🪙')} Amount: ${budgetDisplay}\n\n` +
                `Open Tonkeeper to approve.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 1);
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;

        if (isJetton) {
            // Mnemonic USDT fund: jetton transfer
            const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
            const cjwRes = await client.runMethod(Address.parse(USDT_MASTER), 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(w.wallet.address).endCell() }
            ]);
            const clientJw = cjwRes.stack.readAddress();
            const jettonBody = beginCell()
                .storeUint(0x0f8a7ea5, 32).storeUint(0, 64)
                .storeCoins(status.budget)
                .storeAddress(jobAddr).storeAddress(w.wallet.address)
                .storeBit(false).storeCoins(toNano('0.05')).storeBit(false)
                .endCell();
            await ctx.reply(`${e('⏳')} Funding USDT job #${jobId}...`, { parse_mode: 'HTML' });
            await sendTx(client, w, clientJw, toNano('0.1'), jettonBody);
        } else {
            const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
            const amount = status.budget + toNano('0.01');
            await ctx.reply(`${e('⏳')} Funding job #${jobId}...`, { parse_mode: 'HTML' });
            await sendTx(client, w, jobAddr, amount, body);
        }

        const statusCb = isJetton ? `jstatus_${jobId}` : `status_${jobId}`;
        const kb = new InlineKeyboard()
            .text('🔭 Status', statusCb)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('💰')} <b>Job #${jobId} Funded!</b>\n\n` +
            `${e('🪙')} Amount: ${budgetDisplay}\n` +
            `Funds are in escrow. Waiting for a provider.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleTake(ctx: any, jobId: number, factory = FACTORY_ADDRESS) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const body = beginCell().storeUint(JobOpcodes.takeJob, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('🤝')} <b>Take Job #${jobId}</b>\n\nOpen Tonkeeper to approve. Auto-detecting...`, { parse_mode: 'HTML', reply_markup: kb });
            // Poll for provider field change
            const existingW = tcWatchers.get(userId);
            if (existingW) clearInterval(existingW);
            let takeAttempts = 0;
            const takeTimer = setInterval(async () => {
                takeAttempts++;
                if (takeAttempts > 40) { clearInterval(takeTimer); tcWatchers.delete(userId); return; }
                try {
                    const c = await createClient();
                    const s = await getJobStatus(c, jobAddr.toString());
                    if (s.provider !== 'none') {
                        clearInterval(takeTimer); tcWatchers.delete(userId);
                        const tkb = new InlineKeyboard()
                            .text('🔭 Status', `status_${jobId}`)
                            .text('🏠 Menu', 'menu_main');
                        await bot.api.sendMessage(ctx.chat!.id,
                            `${e('🤝')} <b>Job #${jobId} Taken!</b>\n\nSubmit your result:\n<code>/submit ${factory === JETTON_FACTORY_ADDRESS ? 'j' : ''}${jobId} your_result_text</code>`,
                            { parse_mode: 'HTML', reply_markup: tkb });
                    }
                } catch {}
            }, 3000);
            tcWatchers.set(userId, takeTimer);
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} Taking job #${jobId}...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, toNano('0.01'), body);
        await new Promise(r => setTimeout(r, 8000));

        const newStatus = await getJobStatus(client, jobAddr.toString());
        const prefix = factory === JETTON_FACTORY_ADDRESS ? 'j' : '';
        const statusCb = factory === JETTON_FACTORY_ADDRESS ? `jstatus_${jobId}` : `status_${jobId}`;
        const kb = new InlineKeyboard().text('🔭 Status', statusCb).text('🏠 Menu', 'menu_main');
        if (newStatus.provider !== 'none') {
            await ctx.reply(`${e('🤝')} <b>Job #${jobId} Taken!</b>\n\nSubmit your result:\n<code>/submit ${prefix}${jobId} your_result_text</code>`, { parse_mode: 'HTML', reply_markup: kb });
        } else {
            await ctx.reply(`${e('⚠️')} Transaction sent but not confirmed yet. Check status in a few seconds.`, { parse_mode: 'HTML', reply_markup: kb });
        }
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleCancel(ctx: any, jobId: number, factory = FACTORY_ADDRESS) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const status = await getJobStatus(client, jobAddr.toString());
        const deadline = status.createdAt + status.timeout;
        const now = Math.floor(Date.now() / 1000);
        if (now < deadline) {
            const left = deadline - now;
            return ctx.reply(
                `${e('⚠️')} <b>Cannot cancel yet</b>\n\n` +
                `Timeout expires in <b>${Math.floor(left/3600)}h ${Math.floor((left%3600)/60)}m</b>.\n` +
                `Cancel will be available after that.`,
                { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main') }
            );
        }
        const body = beginCell().storeUint(JobOpcodes.cancel, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Cancel in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('🚫')} <b>Cancel Job #${jobId}</b>\n\nTimeout expired. Open Tonkeeper to approve.`, { parse_mode: 'HTML', reply_markup: kb });
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 5); // 5=CANCELLED
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} Cancelling job #${jobId}...\n${e('⚠️')} Only works after timeout (24h).`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main');
        await ctx.reply(`${e('🚫')} <b>Job #${jobId} Cancelled</b>\n\nFunds refunded to the client.`, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleClaim(ctx: any, jobId: number, factory = FACTORY_ADDRESS) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const status = await getJobStatus(client, jobAddr.toString());

        // Check eval timeout
        if (status.submittedAt > 0) {
            const evalDeadline = status.submittedAt + status.evalTimeout;
            const now = Math.floor(Date.now() / 1000);
            if (now < evalDeadline) {
                const left = evalDeadline - now;
                return ctx.reply(
                    `${e('⚠️')} <b>Cannot claim yet</b>\n\n` +
                    `Evaluation timeout expires in <b>${Math.floor(left/3600)}h ${Math.floor((left%3600)/60)}m</b>.`,
                    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main') }
                );
            }
        }

        const body = beginCell().storeUint(JobOpcodes.claim, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Claim in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('⏰')} <b>Claim Job #${jobId}</b>\n\nEval timeout expired. Open Tonkeeper to approve.`, { parse_mode: 'HTML', reply_markup: kb });
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 3);
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} Claiming funds for #${jobId}...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main');
        await ctx.reply(`${e('⏰')} <b>Job #${jobId} Claimed!</b>\n\nEvaluator timed out — funds sent to the provider.`, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleQuit(ctx: any, jobId: number, factory = FACTORY_ADDRESS) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const body = beginCell().storeUint(JobOpcodes.quit, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('🚪')} <b>Quit Job #${jobId}</b>\n\nOpen Tonkeeper to approve. Auto-detecting...`, { parse_mode: 'HTML', reply_markup: kb });
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} Quitting job #${jobId}...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main');
        await ctx.reply(`${e('🚪')} <b>Quit Job #${jobId}</b>\n\nJob is open again for other providers.`, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleEvaluate(ctx: any, jobId: number, approved: boolean, factory = FACTORY_ADDRESS) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, factory, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(0n, 256)
            .endCell();

        const evalGas = toNano('0.01');

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), evalGas, body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(
                `${approved ? e('✅') : e('❌')} <b>${approved ? 'Approve' : 'Reject'} Job #${jobId}</b>\n\nOpen Tonkeeper to approve.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), approved ? 3 : 4);
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} ${approved ? 'Approving' : 'Rejecting'} job #${jobId}...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, evalGas, body);

        const kb = new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main');
        if (approved) {
            await ctx.reply(`${e('✅')} <b>Job #${jobId} Approved!</b>\n\nFunds sent to the provider. ${e('🎉')}`, { parse_mode: 'HTML', reply_markup: kb });
        } else {
            await ctx.reply(`${e('❌')} <b>Job #${jobId} Rejected</b>\n\nFunds refunded to the client.`, { parse_mode: 'HTML', reply_markup: kb });
        }
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleJettonStatus(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, JETTON_FACTORY_ADDRESS, jobId);
        const s = await getJobStatus(client, jobAddr.toString());

        const stateIcon: Record<string, string> = {
            OPEN: e('🟢'), FUNDED: e('💰'), SUBMITTED: e('📨'),
            COMPLETED: e('✅'), DISPUTED: e('⚠️'), CANCELLED: e('🚫'),
        };
        const icon = stateIcon[s.stateName] ?? '❓';

        const desc = jobDescriptions.get(jobId + 100000) ?? await decodeDesc(s.descHash);
        const resultText = (s.stateName === 'SUBMITTED' || s.stateName === 'COMPLETED' || s.stateName === 'DISPUTED') ? await decodeDesc(s.resultHash) : null;
        const reasonText = (s.stateName === 'COMPLETED' || s.stateName === 'DISPUTED') ? decodeHexOnly(s.reasonHash) : null;
        const descCid = desc ? await findCID(s.descHash) : null;
        const resCid = resultText ? await findCID(s.resultHash) : null;
        let text =
            `${icon} <b>Jetton Job #${s.jobId}</b> ${e('💵')}\n\n` +
            `${e('📊')} State: <b>${s.stateName}</b>\n` +
            `${e('💵')} Budget: <b>${fmtUsdt(s.budget)}</b> ${e('💵')}\n` +
            (desc ? `\n${e('📄')} <b>Description:</b>\n<blockquote>${descCid ? `<a href="${PINATA_GW}/${descCid}">` : ''}${desc.length > 120 ? desc.slice(0, 120) + '...' : desc}${descCid ? '</a>' : ''}</blockquote>\n` : '') +
            (resultText ? `${e('📨')} <b>Result:</b>\n<blockquote>${resCid ? `<a href="${PINATA_GW}/${resCid}">` : ''}${resultText.length > 120 ? resultText.slice(0, 120) + '...' : resultText}${resCid ? '</a>' : ''}</blockquote>\n` : '') +
            (reasonText ? `${e('⚖️')} <b>Reason:</b> <i>${reasonText.length > 80 ? reasonText.slice(0, 80) + '...' : reasonText}</i>\n` : '') +
            `\n` +
            `${eid(EID.forClients, '👤')} Client: <code>${s.client}</code>\n` +
            `${eid(EID.forProviders, '🔧')} Provider: <code>${s.provider}</code>\n` +
            `${e('⚖️')} Evaluator: ${s.evaluator === 'UQCDP52RhgJmylkjOBSJGqCsaTwRo9XFzrr6opHUg4mqkQAu' ? '🤖 AI' : ''} <code>${s.evaluator}</code>\n` +
            `${eid(EID.timeout, '⏰')} Timeout: ${s.timeout / 3600}h${s.createdAt > 0 ? (() => { const left = (s.createdAt + s.timeout) - Math.floor(Date.now()/1000); return left > 0 ? ' | ' + Math.floor(left/3600) + 'h ' + Math.floor((left%3600)/60) + 'm left' : ' | expired'; })() : ''}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>`;

        const kb = new InlineKeyboard();
        const userAddr = await getUserAddr(userId);
        const isClient = userAddr && s.client === userAddr;
        const isProvider = userAddr && s.provider === userAddr;
        const isEvaluator = userAddr && s.evaluator === userAddr;

        switch (s.stateName) {
            case 'OPEN':
                if (isClient) kb.text('💰 Fund', `jfund_${jobId}`);
                break;
            case 'FUNDED':
                if (s.provider === 'none') {
                    if (!isClient) kb.text('🤝 Take Job', `jtake_${jobId}`);
                } else if (isProvider) {
                    kb.text('📨 Submit Result', `jsubmit_prompt_${jobId}`);
                    kb.text('🚪 Quit', `jquit_${jobId}`);
                }
                if (isClient) kb.text('🚫 Cancel', `jcancel_${jobId}`);
                break;
            case 'SUBMITTED':
                if (isEvaluator || isClient) {
                    kb.text('✅ Approve', `japprove_${jobId}`)
                      .text('❌ Reject', `jreject_${jobId}`).row();
                }
                if (isProvider) kb.text('⏰ Claim (timeout)', `jclaim_${jobId}`);
                break;
            case 'COMPLETED':
                text += `\n\n${e('🎉')} Job completed!`;
                break;
            case 'CANCELLED':
                text += `\n\n${e('🚫')} Job cancelled.`;
                break;
        }

        kb.row()
          .url('🔗 Explorer', explorerLink(jobAddr.toString()))
          .text('🏠 Menu', 'menu_main');

        await respond(ctx, text, { reply_markup: kb, link_preview_options: { is_disabled: true } });
    } catch (err: any) {
        await respond(ctx, `${e('❌')} Error: ${err.message}`);
    }
}

async function showHelp(ctx: any) {
    const kb = new InlineKeyboard()
        .text('✍️ Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('👛 Wallet', 'menu_wallet')
        .text('🏠 Menu', 'menu_main');

    await respond(ctx,
        `${logo()} <b>Help — ENACT Protocol Bot</b>\n\n` +
        `<b>${e('👛')} Wallet:</b>\n` +
        `  👛 Connect — via Tonkeeper (recommended)\n` +
        `  /connect — via mnemonic (advanced)\n` +
        `  /disconnect — Disconnect wallet\n` +
        `  /wallet — Wallet info & balance\n\n` +
        `<b>${eid(EID.forClients, '👤')} For Clients:</b>\n` +
        `  /create — Create a TON job (evaluator optional)\n` +
        `  /createjetton — Create a USDT job (evaluator optional)\n` +
        `  /fund — Fund a job with ${eid(EID.tonCoin, '💎')}\n` +
        `  /budget — Change job budget\n` +
        `  /cancel — Cancel after timeout (24h)\n\n` +
        `<b>${e('⚖️')} For Evaluators:</b>\n` +
        `  /evaluate — Review job + approve or reject\n` +
        `  /approve — Approve submitted result\n` +
        `  /reject — Reject submitted result\n\n` +
        `<b>${eid(EID.forProviders, '🔧')} For Providers:</b>\n` +
        `  /take — Take an open job\n` +
        `  /submit — Submit your result\n` +
        `  /claim — Claim funds (eval timeout)\n` +
        `  /quit — Quit before submitting\n\n` +
        `<b>${e('🔭')} Info:</b>\n` +
        `  /status — Check job status\n` +
        `  /jobs — List all jobs\n` +
        `  /factory — Factory contract addresses\n\n` +
        `${e('💡')} Job lifecycle:\n` +
        `OPEN → FUNDED → SUBMITTED → COMPLETED`,
        { reply_markup: kb }
    );
}

// ─── Real-time transaction tracking (TON Streaming API v2 + polling fallback) ───

async function startFactoryWatcher() {
    const client = await createClient();
    try {
        lastKnownJobId = await getFactoryJobCount(client, FACTORY_ADDRESS);
    } catch { lastKnownJobId = 0; }

    const apiKey = process.env.TONCENTER_API_KEY ?? '';

    // Use polling — SSE has connection limits on toncenter free tier
    startPollingFallback();
}

async function connectSSE(apiKey: string) {
    const factoryRaw = Address.parse(FACTORY_ADDRESS).toRawString();
    let failures = 0;

    while (true) {
        if (failures >= 3) {
            console.log('SSE failed 3 times, switching to polling');
            startPollingFallback();
            return;
        }
        try {
            console.log('Connecting to TON Streaming API v2...');
            const res = await fetch('https://toncenter.com/api/streaming/v2/sse', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
                },
                body: JSON.stringify({
                    addresses: [factoryRaw],
                    types: ['transactions'],
                    min_finality: 'confirmed',
                }),
            });

            if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
            console.log('Connected to TON Streaming API v2');

            const reader = (res.body as any).getReader();
            const decoder = new TextDecoder();
            let buf = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });

                while (buf.includes('\n')) {
                    const idx = buf.indexOf('\n');
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);

                    if (line.startsWith('data:')) {
                        onFactoryTransaction().catch(err =>
                            console.error('SSE tx handler error:', err.message));
                    }
                }
            }
        } catch (err: any) {
            console.error('SSE error:', err.message ?? err);
            failures++;
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

function startPollingFallback() {
    console.log('Factory polling started (every 4s)');
    setInterval(async () => {
        if (pendingCreate.size === 0) return;
        try {
            const client = await createClient();
            const currentId = await getFactoryJobCount(client, FACTORY_ADDRESS);
            if (currentId > lastKnownJobId) {
                lastKnownJobId = currentId;
                await onFactoryTransaction();
            }
        } catch {}
    }, 4000);
}

async function onFactoryTransaction() {
    if (pendingCreate.size === 0) return;

    // Small delay to let state propagate
    await new Promise(r => setTimeout(r, 2000));

    try {
        const client = await createClient();
        const jobCount = await getFactoryJobCount(client, FACTORY_ADDRESS);
        const newJobId = jobCount - 1;
        if (newJobId < 0) return;

        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, newJobId);
        const jobStatus = await getJobStatus(client, jobAddr.toString());
        const newJobClient = jobStatus.client;

        for (const [userId, pending] of pendingCreate) {
            const userAddr = userTcAddresses.get(userId);
            if (!userAddr) continue;

            try {
                if (!Address.parse(userAddr).equals(Address.parse(newJobClient))) continue;
            } catch { continue; }

            // Match found — this user's job was created
            pendingCreate.delete(userId);
            saveDescription(newJobId, pending.description);
            lastKnownJobId = jobCount;

            const chatId = pendingChats.get(userId);
            pendingChats.delete(userId);
            if (!chatId) continue;

            const fundBody = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
            const fundAmount = toNano(pending.budgetTon) + toNano('0.01');
            const fundLink = tonTransferLink(jobAddr.toString(), fundAmount, fundBody);

            const kb = new InlineKeyboard()
                .url(`🪙 Fund ${pending.budgetTon} TON`, fundLink).row()
                .text('🔭 Status', `status_${newJobId}`)
                .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
                .text('🏠 Main Menu', 'menu_main');

            await bot.api.sendMessage(chatId,
                `${e('✅')} <b>Job Created!</b>\n\n` +
                `${e('🆔')} ID: <code>${newJobId}</code>\n` +
                `${e('🪙')} Budget: ${ton(pending.budgetTon)}\n` +
                `${e('📄')} Description: ${pending.description}\n` +
                `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
                `Press <b>"Fund"</b> to deposit ${ton(pending.budgetTon)} into escrow.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );

            // Start watching for fund confirmation
            watchJobState(userId, chatId, newJobId, jobAddr.toString(), 1);
            break;
        }
    } catch (err: any) {
        console.error('onFactoryTransaction error:', err.message);
    }
}

/** Watch a job contract for a state change and auto-notify the user */
function watchJobState(userId: number, chatId: number, jobId: number, jobAddress: string, expectedState: number) {
    const existing = tcWatchers.get(userId);
    if (existing) clearInterval(existing);

    let attempts = 0;
    const timer = setInterval(async () => {
        attempts++;
        if (attempts > 40) { // ~2 min
            clearInterval(timer);
            tcWatchers.delete(userId);
            return;
        }

        try {
            const client = await createClient();
            const s = await getJobStatus(client, jobAddress);

            if (s.state >= expectedState) {
                clearInterval(timer);
                tcWatchers.delete(userId);

                const labels: Record<number, string> = {
                    1: 'FUNDED', 2: 'SUBMITTED', 3: 'COMPLETED', 4: 'DISPUTED', 5: 'CANCELLED',
                };
                const msgs: Record<number, string> = {
                    1: `Funds locked in escrow. Waiting for a provider.`,
                    2: `Result submitted. Waiting for evaluation.`,
                    3: `Job completed! Funds sent to provider. ${e('🎉')}`,
                    4: `Job disputed. Funds refunded to client.`,
                    5: `Job cancelled. Funds refunded.`,
                };

                const kb = new InlineKeyboard()
                    .text('🔭 Status', `status_${jobId}`)
                    .url('🔗 Explorer', explorerLink(jobAddress)).row()
                    .text('🏠 Menu', 'menu_main');

                await bot.api.sendMessage(chatId,
                    `${e('✅')} <b>Job #${jobId} — ${labels[s.state] ?? 'UPDATED'}</b>\n\n` +
                    `${msgs[s.state] ?? 'Status updated.'}`,
                    { parse_mode: 'HTML', reply_markup: kb }
                );
            }
        } catch {}
    }, 3000);

    tcWatchers.set(userId, timer);
}

// ─── Start ───
async function main() {
    loadWallets();
    loadDescriptions();
    await loadCustomEmoji();
    // Retry start with delay — previous Render instance may still be running
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await bot.api.deleteWebhook({ drop_pending_updates: true });
            bot.start({ onStart: () => console.log('ENACT Protocol bot started') });
            break;
        } catch (err: any) {
            if (err.error_code === 409 && attempt < 4) {
                console.log(`Bot conflict (attempt ${attempt + 1}/5), waiting 10s...`);
                await new Promise(r => setTimeout(r, 10000));
            } else {
                throw err;
            }
        }
    }

    // Start real-time factory watcher (non-blocking)
    startFactoryWatcher().catch(err =>
        console.error('Factory watcher failed:', err.message));

    // Health-check HTTP server for Render
    const port = process.env.PORT || 10000;
    http.createServer((_, res) => {
        res.writeHead(200);
        res.end('ENACT Bot OK');
    }).listen(port, () => console.log(`Health server on :${port}`));
}

main();
