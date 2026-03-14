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

async function decodeDesc(hash: string): Promise<string | null> {
    if (!hash || hash === '0'.repeat(64)) return null;
    try {
        // Try 1: decode as hex-encoded text (bot creates these)
        const clean = hash.replace(/0+$/, '');
        if (clean.length >= 2) {
            const text = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
            if (/^[\x20-\x7E]+$/.test(text) && text.length > 2) {
                return escapeHtml(text);
            }
        }
        // Try 2: search Pinata pins and match by SHA-256
        const jwt = process.env.PINATA_JWT;
        if (jwt) {
            // First try metadata search (new uploads have descHash tag)
            try {
                const searchRes = await fetch(`https://api.pinata.cloud/data/pinList?metadata[keyvalues][descHash]={"value":"${hash}","op":"eq"}&status=pinned&pageLimit=1`, {
                    headers: { 'Authorization': `Bearer ${jwt}` },
                    signal: AbortSignal.timeout(4000),
                });
                if (searchRes.ok) {
                    const pins = await searchRes.json() as { rows: Array<{ ipfs_pin_hash: string }> };
                    if (pins.rows?.length > 0) {
                        const cid = pins.rows[0].ipfs_pin_hash;
                        const ipfsRes = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`, { signal: AbortSignal.timeout(4000) });
                        if (ipfsRes.ok) {
                            const data = await ipfsRes.json();
                            const content = data.description ?? data.result ?? null;
                            if (content) return escapeHtml(String(content).slice(0, 200));
                        }
                    }
                }
            } catch {}
            // Fallback: list all pins and check content hash
            try {
                const listRes = await fetch(`https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=20`, {
                    headers: { 'Authorization': `Bearer ${jwt}` },
                    signal: AbortSignal.timeout(5000),
                });
                if (listRes.ok) {
                    const { createHash } = await import('crypto');
                    const pins = await listRes.json() as { rows: Array<{ ipfs_pin_hash: string }> };
                    for (const pin of pins.rows) {
                        try {
                            const ipfsRes = await fetch(`https://gateway.pinata.cloud/ipfs/${pin.ipfs_pin_hash}`, { signal: AbortSignal.timeout(3000) });
                            if (!ipfsRes.ok) continue;
                            const text = await ipfsRes.text();
                            const contentHash = createHash('sha256').update(text, 'utf-8').digest('hex');
                            if (contentHash === hash) {
                                const data = JSON.parse(text);
                                const content = data.description ?? data.result ?? null;
                                if (content) return escapeHtml(String(content).slice(0, 200));
                            }
                        } catch { continue; }
                    }
                }
            } catch {}
        }
    } catch {}
    return null;
}

function getUserId(ctx: any): number {
    return ctx.from?.id ?? 0;
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

    await ctx.reply(
        `${logo()} <b>ENACT Protocol</b>\n\n` +
        `Trustless escrow for AI agent jobs on TON.\n\n` +
        `${e('👛')} Wallet: ${connected ? '<b>Connected</b>' : '<i>Not connected</i>'}\n` +
        `${e('🔗')} Network: TON Mainnet\n\n` +
        `Choose an action:`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

bot.callbackQuery('menu_create', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `${e('✍️')} <b>Create a Job</b>\n\n` +
        `${e('💎')} <b>TON payment:</b>\n` +
        `<code>/create {amount} {description}</code>\n` +
        `Example: <code>/create 5 Write a smart contract</code>\n\n` +
        `${e('💵')} <b>USDT payment:</b>\n` +
        `<code>/createjetton {amount} {description}</code>\n` +
        `Example: <code>/createjetton 10 Audit this code</code>`,
        { parse_mode: 'HTML' }
    );
});

bot.callbackQuery('menu_jobs', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleJobs(ctx, 0);
});

bot.callbackQuery('menu_status', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `${e('🔭')} <b>Check Job Status</b>\n\n` +
        `Send the command:\n` +
        `<code>/status job_id</code>\n\n` +
        `Example: <code>/status 0</code>`,
        { parse_mode: 'HTML' }
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
    await ctx.reply(
        `${e('🔑')} <b>Connect via Mnemonic</b>\n\n` +
        `Send your 24-word mnemonic phrase:\n` +
        `<code>/connect word1 word2 ... word24</code>\n\n` +
        `${e('🔒')} Your mnemonic is stored encrypted on the server.\n` +
        `${e('⚠️')} Send this in a <b>private chat</b> with the bot for security.`,
        { parse_mode: 'HTML' }
    );
});

bot.callbackQuery('menu_factory', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleFactory(ctx);
});

bot.callbackQuery('menu_evaluate', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `${e('⚖️')} <b>Evaluate a Job</b>\n\n` +
        `Send the command:\n` +
        `<code>/evaluate job_id</code>\n\n` +
        `Example: <code>/evaluate 0</code>\n\n` +
        `${e('💡')} You must be the evaluator of the job. The bot will show the submitted result and let you approve or reject.`,
        { parse_mode: 'HTML' }
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
    await ctx.reply(
        `${e('✅')} Wallet disconnected.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
});

bot.callbackQuery('check_created', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);
    const pending = pendingCreate.get(userId);
    if (!pending) {
        return ctx.reply(`${e('❌')} No pending job creation found.`, { parse_mode: 'HTML' });
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

        await ctx.reply(
            `${e('✅')} <b>Job Created!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('🪙')} Budget: ${ton(pending.budgetTon)}\n` +
            `${e('📄')} Description: ${pending.description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `Now press <b>"Fund"</b> to deposit ${ton(pending.budgetTon)} into escrow.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(
            `${e('⏳')} Job not found on-chain yet. Wait ~10 seconds and try again.\n\n` +
            `${e('💡')} Press "Check if Created" again after Tonkeeper confirms.`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔄 Check Again', 'check_created').row().text('🏠 Menu', 'menu_main') }
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
            `Usage:\n<code>/create {amount in TON} {description}</code>\n\n` +
            `Example: <code>/create 5 Write a smart contract</code>\n\n` +
            `${e('🪙')} The amount is the job budget in ${eid(EID.tonCoin, '💎')}.`,
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

    const description = args.slice(1).join(' ');
    const descHash = BigInt('0x' + Buffer.from(description).toString('hex').padEnd(64, '0').slice(0, 64));

    try {
        const client = await createClient();

        if (mode === 'tonconnect') {
            const addr = userTcAddresses.get(userId)!;
            const createBody = beginCell()
                .storeUint(FactoryOpcodes.createJob, 32)
                .storeAddress(Address.parse(addr))
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

            return ctx.reply(
                `${e('✍️')} <b>Create & Fund Job</b>\n\n` +
                `${e('🪙')} Budget: ${ton(budgetTon)}\n` +
                `${e('📄')} Description: ${description}\n\n` +
                `Approve <b>both</b> transactions in Tonkeeper:\n` +
                `1️⃣ Create job (~0.03 ${eid(EID.tonCoin, '💎')} gas)\n` +
                `2️⃣ Fund with ${ton(budgetTon)}\n\n` +
                `${e('💡')} Wait ~10s between approvals. Bot will auto-detect confirmations.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }

        const w = await requireWallet(ctx);
        if (!w) return;

        await ctx.reply(`${e('⏳')} Creating and funding job...`, { parse_mode: 'HTML' });

        // Step 1: Create job
        const createBody = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(w.wallet.address)
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
            `Job is ready — waiting for a provider to take it.`,
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

    const description = args.slice(1).join(' ');
    const descHash = BigInt('0x' + Buffer.from(description).toString('hex').padEnd(64, '0').slice(0, 64));

    try {
        const client = await createClient();

        if (mode === 'tonconnect') {
            const addr = userTcAddresses.get(userId)!;
            const usdtBudget = BigInt(Math.round(parseFloat(budgetTon) * 1e6)); // USDT: 6 decimals
            const createBody = beginCell()
                .storeUint(FactoryOpcodes.createJob, 32)
                .storeAddress(Address.parse(addr))
                .storeCoins(usdtBudget)
                .storeUint(descHash, 256)
                .storeUint(86400, 32)
                .storeUint(86400, 32)
                .endCell();

            const createLink = tonTransferLink(JETTON_FACTORY_ADDRESS, toNano('0.03'), createBody);

            pendingCreate.set(userId, { budgetTon, description });
            pendingChats.set(userId, ctx.chat!.id);

            const kb = new InlineKeyboard()
                .url('1️⃣ Create Jetton Job', createLink).row()
                .text('🔄 Check Manually', 'check_created_jetton').row()
                .text('🏠 Main Menu', 'menu_main');

            return ctx.reply(
                `${e('💵')} <b>Create Jetton Job</b>\n\n` +
                `${e('🪙')} Budget: <b>${budgetTon}</b> USDT\n` +
                `${e('📄')} Description: ${description}\n\n` +
                `Approve the transaction in Tonkeeper.\n` +
                `USDT wallet is set automatically after creation.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }

        const w = await requireWallet(ctx);
        if (!w) return;

        await ctx.reply(`${e('⏳')} Creating Jetton job...`, { parse_mode: 'HTML' });

        const usdtBudget = BigInt(Math.round(parseFloat(budgetTon) * 1e6)); // USDT: 6 decimals
        const createBody = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(w.wallet.address)
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
            `USDT wallet set automatically. Ready to fund.`,
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
        return ctx.reply(`${e('❌')} No pending job creation found.`, { parse_mode: 'HTML' });
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

        await ctx.reply(
            `${e('✅')} <b>Jetton Job Created!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('💵')} Budget: <b>${pending.budgetTon}</b> USDT\n` +
            `${e('📄')} Description: ${pending.description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `USDT wallet set. Ready to fund.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(
            `${e('⏳')} Job not found yet. Wait ~10 seconds and try again.`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔄 Check Again', 'check_created_jetton').row().text('🏠 Menu', 'menu_main') }
        );
    }
});

bot.callbackQuery(/^jstatus_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await handleJettonStatus(ctx, jobId);
});

bot.command('fund', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/fund job_id</code>`, { parse_mode: 'HTML' });
    await handleFund(ctx, jobId);
});

bot.command('take', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/take job_id</code>`, { parse_mode: 'HTML' });
    await handleTake(ctx, jobId);
});

bot.command('submit', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `${e('❌')} <b>Invalid format</b>\n\nUsage:\n<code>/submit job_id result_text</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const w = await requireWallet(ctx);
    if (!w) return;

    const jobId = parseInt(args[0]);
    const resultText = args.slice(1).join(' ');
    const resultHash = BigInt('0x' + Buffer.from(resultText).toString('hex').padEnd(64, '0').slice(0, 64));

    try {
        await ctx.reply(`${e('⏳')} Submitting result...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.submitResult, 32)
            .storeUint(resultHash, 256)
            .storeUint(0, 8)
            .endCell();
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('📨')} <b>Result Submitted!</b>\n\n` +
            `${e('🆔')} Job: #${jobId}\n` +
            `Awaiting evaluation from the evaluator.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
});

bot.command('approve', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/approve job_id</code>`, { parse_mode: 'HTML' });
    await handleEvaluate(ctx, jobId, true);
});

bot.command('reject', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/reject job_id</code>`, { parse_mode: 'HTML' });
    await handleEvaluate(ctx, jobId, false);
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
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/cancel job_id</code>`, { parse_mode: 'HTML' });
    await handleCancel(ctx, jobId);
});

bot.command('claim', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/claim job_id</code>`, { parse_mode: 'HTML' });
    await handleClaim(ctx, jobId);
});

bot.command('quit', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/quit job_id</code>`, { parse_mode: 'HTML' });
    await handleQuit(ctx, jobId);
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

bot.command('jobs', async (ctx) => handleJobs(ctx, 0));

bot.callbackQuery(/^jobs_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match![1]);
    await handleJobs(ctx, page);
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

        return ctx.reply(
            `${e('👛')} <b>Wallet</b>\n\n` +
            `${e('🚫')} No wallet connected.\n\n` +
            `Connect your wallet to create jobs, fund escrow, and interact with ENACT contracts.`,
            { parse_mode: 'HTML', reply_markup: kb }
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

        await ctx.reply(
            `${e('👛')} <b>Your Wallet</b>\n\n` +
            `${e('📍')} Address:\n<code>${addr}</code>\n\n` +
            `${e('🪙')} Balance: ${ton((Number(balance) / 1e9).toFixed(2))}\n` +
            `${e('🔗')} Mode: <b>${modeLabel}</b>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleFactory(ctx: any) {
    const kb = new InlineKeyboard()
        .url('💎 JobFactory', explorerLink(FACTORY_ADDRESS))
        .url('💵 JettonJobFactory', explorerLink(JETTON_FACTORY_ADDRESS)).row()
        .text('🏠 Main Menu', 'menu_main');

    await ctx.reply(
        `${logo()} <b>ENACT Factories</b>\n` +
        `${e('🔗')} TON Mainnet\n\n` +
        `${e('💎')} <b>JobFactory</b> (TON payments):\n` +
        `<code>${FACTORY_ADDRESS}</code>\n\n` +
        `${e('💵')} <b>JettonJobFactory</b> (USDT payments):\n` +
        `<code>${JETTON_FACTORY_ADDRESS}</code>`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
}

async function handleJobs(ctx: any, page: number) {
    const PAGE_SIZE = 5;
    try {
        const client = await createClient();
        const count = await getFactoryJobCount(client, FACTORY_ADDRESS);

        if (count === 0) {
            const kb = new InlineKeyboard()
                .text('✍️ Create First Job', 'menu_create').row()
                .text('🏠 Main Menu', 'menu_main');
            return ctx.reply(`${e('📋')} No jobs yet. Create the first one!`, { parse_mode: 'HTML', reply_markup: kb });
        }

        const totalPages = Math.ceil(count / PAGE_SIZE);
        const safePage = Math.min(page, totalPages - 1);
        const start = Math.max(0, count - (safePage + 1) * PAGE_SIZE);
        const end = count - safePage * PAGE_SIZE;

        let text = `${eid(EID.browseJobs, '📋')} <b>Jobs (${count} total)</b>`;
        if (totalPages > 1) text += ` — page ${safePage + 1}/${totalPages}`;
        text += '\n\n';

        const stateIcon: Record<string, string> = {
            OPEN: e('🟢'), FUNDED: e('💰'), SUBMITTED: e('📨'),
            COMPLETED: e('✅'), DISPUTED: e('⚠️'), CANCELLED: e('🚫'),
        };

        for (let i = start; i < end; i++) {
            const addr = await getJobAddress(client, FACTORY_ADDRESS, i);
            try {
                const s = await getJobStatus(client, addr.toString());
                const icon = stateIcon[s.stateName] ?? '❓';
                const desc = jobDescriptions.get(i);
                text += `${icon} <b>#${i}</b> — ${s.stateName} | ${ton(fmtTon(s.budget))}`;
                if (desc) text += `\n     ${e('📄')} <i>${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}</i>`;
                text += '\n';
            } catch {
                text += `⬜ <b>#${i}</b> — (not initialized)\n`;
            }
            if (i < end - 1) await new Promise(r => setTimeout(r, 300));
        }

        // Also show Jetton jobs (on first page only)
        let jettonCount = 0;
        if (safePage === 0) {
            try { jettonCount = await getFactoryJobCount(client, JETTON_FACTORY_ADDRESS); } catch {}
            if (jettonCount > 0) {
                text += `\n${e('💵')} <b>Jetton Jobs (${jettonCount} total)</b>\n\n`;
                const jStart = Math.max(0, jettonCount - 5);
                for (let i = jStart; i < jettonCount; i++) {
                    const addr = await getJobAddress(client, JETTON_FACTORY_ADDRESS, i);
                    try {
                        const s = await getJobStatus(client, addr.toString());
                        const icon = stateIcon[s.stateName] ?? '❓';
                        text += `${icon} <b>J#${i}</b> — ${s.stateName} | <b>${fmtUsdt(s.budget)}</b> ${e('💵')}\n`;
                    } catch {
                        text += `⬜ <b>J#${i}</b> — (not initialized)\n`;
                    }
                    if (i < jettonCount - 1) await new Promise(r => setTimeout(r, 300));
                }
            }
        }

        const kb = new InlineKeyboard();
        for (let i = start; i < end; i++) {
            kb.text(`🔭 #${i}`, `status_${i}`);
        }
        if (safePage === 0 && jettonCount > 0) {
            kb.row();
            for (let i = Math.max(0, jettonCount - 5); i < jettonCount; i++) {
                kb.text(`💵 J#${i}`, `jstatus_${i}`);
            }
        }
        kb.row();

        // Pagination buttons
        if (safePage < totalPages - 1) kb.text('⬅️ Older', `jobs_page_${safePage + 1}`);
        if (safePage > 0) kb.text('Newer ➡️', `jobs_page_${safePage - 1}`);
        if (totalPages > 1) kb.row();

        kb.text('✍️ Create Job', 'menu_create')
          .text('🏠 Menu', 'menu_main');

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
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
        const resultText = (s.stateName === 'SUBMITTED' || s.stateName === 'COMPLETED') ? await decodeDesc(s.resultHash) : null;
        let text =
            `${icon} <b>Job #${s.jobId}</b>\n\n` +
            `${e('📊')} State: <b>${s.stateName}</b>\n` +
            `${e('🪙')} Budget: ${ton(fmtTon(s.budget))}\n` +
            (desc ? `${e('📄')} Description: <i>${desc.slice(0, 200)}</i>\n` : '') +
            (resultText ? `${e('📨')} Result: <i>${resultText.slice(0, 200)}</i>\n` : '') +
            `${eid(EID.forClients, '👤')} Client: <code>${s.client}</code>\n` +
            `${eid(EID.forProviders, '🔧')} Provider: <code>${s.provider}</code>\n` +
            `${e('⚖️')} Evaluator: <code>${s.evaluator}</code>\n` +
            `${eid(EID.timeout, '⏰')} Timeout: ${s.timeout / 3600}h\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>`;

        const kb = new InlineKeyboard();

        // Show buttons based on user role
        const userAddr = userTcAddresses.get(userId) ?? '';
        const isClient = userAddr && s.client === userAddr;
        const isProvider = userAddr && s.provider === userAddr;
        const isEvaluator = userAddr && s.evaluator === userAddr;

        switch (s.stateName) {
            case 'OPEN':
                if (isClient) kb.text('💰 Fund', `fund_${jobId}`);
                if (!isClient) kb.text('🤝 Take Job', `take_${jobId}`);
                break;
            case 'FUNDED':
                if (!isClient) kb.text('🤝 Take Job', `take_${jobId}`);
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

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleFund(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const status = await getJobStatus(client, jobAddr.toString());
        const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        const amount = status.budget + toNano('0.01');

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), amount, body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(
                `${e('💰')} <b>Fund Job #${jobId}</b>\n\n` +
                `${e('🪙')} Amount: ${ton(fmtTon(status.budget))}\n\n` +
                `Open Tonkeeper to approve. Bot will auto-detect confirmation.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
            // Auto-detect fund confirmation
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 1);
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;

        await ctx.reply(`${e('⏳')} Funding job #${jobId}...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, amount, body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('💰')} <b>Job #${jobId} Funded!</b>\n\n` +
            `${e('🪙')} Amount: ${ton(fmtTon(status.budget))}\n` +
            `Funds are in escrow. Waiting for a provider.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleTake(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.takeJob, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('🤝')} <b>Take Job #${jobId}</b>\n\nOpen Tonkeeper to approve. Auto-detecting...`, { parse_mode: 'HTML', reply_markup: kb });
            // Take doesn't change state from FUNDED, but provider gets set — watch for SUBMITTED as next expected action
            return;
        }

        const w = await requireWallet(ctx);
        if (!w) return;
        await ctx.reply(`${e('⏳')} Taking job #${jobId}...`, { parse_mode: 'HTML' });
        await sendTx(client, w, jobAddr, toNano('0.01'), body);

        const kb = new InlineKeyboard().text('🔭 Status', `status_${jobId}`).text('🏠 Menu', 'menu_main');
        await ctx.reply(`${e('🤝')} <b>Job #${jobId} Taken!</b>\n\nSubmit your result:\n<code>/submit ${jobId} your_result_text</code>`, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleCancel(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.cancel, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('🚫')} <b>Cancel Job #${jobId}</b>\n\n${e('⚠️')} Cancel works only after timeout expires (24h by default).\n\nOpen Tonkeeper to approve.`, { parse_mode: 'HTML', reply_markup: kb });
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

async function handleClaim(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.claim, 32).endCell();

        if (mode === 'tonconnect') {
            const link = tonTransferLink(jobAddr.toString(), toNano('0.01'), body);
            const kb = new InlineKeyboard()
                .url('👛 Approve in Tonkeeper', link).row()
                .text('🔭 Status', `status_${jobId}`)
                .text('🏠 Menu', 'menu_main');
            await ctx.reply(`${e('⏰')} <b>Claim Job #${jobId}</b>\n\nOpen Tonkeeper to approve. Auto-detecting...`, { parse_mode: 'HTML', reply_markup: kb });
            watchJobState(userId, ctx.chat!.id, jobId, jobAddr.toString(), 3); // 3=COMPLETED
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

async function handleQuit(ctx: any, jobId: number) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
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

async function handleEvaluate(ctx: any, jobId: number, approved: boolean) {
    const userId = getUserId(ctx);
    const mode = walletMode(userId);
    if (!mode) { await requireWallet(ctx); return; }

    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(0n, 256)
            .endCell();

        // Use 0.06 TON gas — Jetton jobs need extra for USDT payout. Excess refunded.
        const evalGas = toNano('0.06');

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
        const resultText = (s.stateName === 'SUBMITTED' || s.stateName === 'COMPLETED') ? await decodeDesc(s.resultHash) : null;
        let text =
            `${icon} <b>Jetton Job #${s.jobId}</b> ${e('💵')}\n\n` +
            `${e('📊')} State: <b>${s.stateName}</b>\n` +
            `${e('💵')} Budget: <b>${fmtUsdt(s.budget)}</b> ${e('💵')}\n` +
            (desc ? `${e('📄')} Description: <i>${desc.slice(0, 200)}</i>\n` : '') +
            (resultText ? `${e('📨')} Result: <i>${resultText.slice(0, 200)}</i>\n` : '') +
            `${eid(EID.forClients, '👤')} Client: <code>${s.client}</code>\n` +
            `${eid(EID.forProviders, '🔧')} Provider: <code>${s.provider}</code>\n` +
            `${e('⚖️')} Evaluator: <code>${s.evaluator}</code>\n` +
            `${eid(EID.timeout, '⏰')} Timeout: ${s.timeout / 3600}h\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>`;

        const kb = new InlineKeyboard();
        const userAddr = userTcAddresses.get(userId) ?? '';
        const isClient = userAddr && s.client === userAddr;
        const isProvider = userAddr && s.provider === userAddr;
        const isEvaluator = userAddr && s.evaluator === userAddr;

        switch (s.stateName) {
            case 'OPEN':
                if (!isClient) kb.text('🤝 Take Job', `take_${jobId}`);
                break;
            case 'FUNDED':
                if (!isClient) kb.text('🤝 Take Job', `take_${jobId}`);
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

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function showHelp(ctx: any) {
    const kb = new InlineKeyboard()
        .text('✍️ Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('👛 Wallet', 'menu_wallet')
        .text('🏠 Menu', 'menu_main');

    await ctx.reply(
        `${logo()} <b>Help — ENACT Protocol Bot</b>\n\n` +
        `<b>${e('👛')} Wallet:</b>\n` +
        `  👛 Connect — via Tonkeeper (recommended)\n` +
        `  /connect — via mnemonic (advanced)\n` +
        `  /disconnect — Disconnect wallet\n` +
        `  /wallet — Wallet info & balance\n\n` +
        `<b>${eid(EID.forClients, '👤')} For Clients:</b>\n` +
        `  /create — Create a TON job\n` +
        `  /createjetton — Create a USDT job\n` +
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
        { parse_mode: 'HTML', reply_markup: kb }
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
    bot.start();
    console.log('ENACT Protocol bot started');

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
