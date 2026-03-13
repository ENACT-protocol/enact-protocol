import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { Address, beginCell, toNano } from '@ton/core';
import {
    createClient, createWalletFromMnemonic, sendTx,
    getJobStatus, getFactoryJobCount, getJobAddress,
    FactoryOpcodes, JobOpcodes, fmtTon, explorerLink,
    FACTORY_ADDRESS, JETTON_FACTORY_ADDRESS,
} from './utils';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1); }

const bot = new Bot(BOT_TOKEN);

// ─── Per-user wallet storage (in-memory) ───
const userWallets = new Map<number, string[]>();

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
        console.log(`Loaded ${Object.keys(ce).length} custom emoji, logo: ${enactLogoId ? 'yes' : 'no'}`);
    } catch {
        console.log('Custom emoji not available, using standard');
    }
}

/** Custom emoji for message text (HTML) — renders animated/static custom emoji */
function e(emoji: string): string {
    const id = ce[emoji];
    if (id) return `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
    return emoji;
}

/** ENACT logo custom emoji for messages */
function logo(): string {
    if (enactLogoId) return `<tg-emoji emoji-id="${enactLogoId}">⚙️</tg-emoji>`;
    return '⚙️';
}

// ─── Helpers ───

function getUserId(ctx: any): number {
    return ctx.from?.id ?? 0;
}

async function requireWallet(ctx: any) {
    const userId = getUserId(ctx);
    const mnemonic = userWallets.get(userId);
    if (!mnemonic) {
        const kb = new InlineKeyboard()
            .text('🔗 Connect Wallet', 'menu_connect');
        await ctx.reply(
            `${e('⚠️')} <b>Wallet not connected</b>\n\n` +
            `Connect your wallet first to perform transactions.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
        return null;
    }
    const client = await createClient();
    return createWalletFromMnemonic(client, mnemonic);
}

// ────────────────────────────────────────────
// /start — Main menu
// ────────────────────────────────────────────
bot.command('start', async (ctx) => {
    const userId = getUserId(ctx);
    const connected = userWallets.has(userId);

    const kb = new InlineKeyboard()
        .text('✍️ Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('🔭 Job Status', 'menu_status')
        .text('👛 Wallet', 'menu_wallet').row()
        .text('📊 Factories', 'menu_factory')
        .text('❓ Help', 'menu_help');

    await ctx.reply(
        `${logo()} <b>ENACT Protocol</b>\n\n` +
        `Trustless escrow for AI agent jobs on TON.\n\n` +
        `${e('👛')} Wallet: ${connected ? '<b>Connected</b>' : '<i>Not connected</i>'}\n` +
        `${e('🌍')} Network: TON Mainnet\n\n` +
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
    const connected = userWallets.has(userId);

    const kb = new InlineKeyboard()
        .text('✍️ Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('🔭 Job Status', 'menu_status')
        .text('👛 Wallet', 'menu_wallet').row()
        .text('📊 Factories', 'menu_factory')
        .text('❓ Help', 'menu_help');

    await ctx.reply(
        `${logo()} <b>ENACT Protocol</b>\n\n` +
        `Trustless escrow for AI agent jobs on TON.\n\n` +
        `${e('👛')} Wallet: ${connected ? '<b>Connected</b>' : '<i>Not connected</i>'}\n` +
        `${e('🌍')} Network: TON Mainnet\n\n` +
        `Choose an action:`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

bot.callbackQuery('menu_create', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `${e('✍️')} <b>Create a Job</b>\n\n` +
        `Send the command:\n` +
        `<code>/create budget description</code>\n\n` +
        `Example:\n` +
        `<code>/create 5 Write a smart contract</code>\n\n` +
        `${e('🪙')} Budget is in TON. The job will be created in OPEN state.`,
        { parse_mode: 'HTML' }
    );
});

bot.callbackQuery('menu_jobs', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleJobs(ctx);
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
    await ctx.reply(
        `${e('👛')} <b>Connect Wallet</b>\n\n` +
        `Send your 24-word mnemonic phrase:\n` +
        `<code>/connect word1 word2 ... word24</code>\n\n` +
        `${e('🔒')} Your mnemonic is stored in memory only and is never saved to disk.\n` +
        `${e('⚠️')} Send this in a <b>private chat</b> with the bot for security.`,
        { parse_mode: 'HTML' }
    );
});

bot.callbackQuery('menu_factory', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleFactory(ctx);
});

bot.callbackQuery('menu_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHelp(ctx);
});

bot.callbackQuery('menu_disconnect', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = getUserId(ctx);
    userWallets.delete(userId);
    await ctx.reply(
        `${e('✅')} Wallet disconnected.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
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
        const addr = w.wallet.address.toString();
        const balance = await client.getBalance(w.wallet.address);

        const userId = getUserId(ctx);
        userWallets.set(userId, words);

        const kb = new InlineKeyboard()
            .url('🔗 Explorer', explorerLink(addr)).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `${e('✅')} <b>Wallet Connected!</b>\n\n` +
            `${e('📍')} Address:\n<code>${addr}</code>\n\n` +
            `${e('🪙')} Balance: <b>${(Number(balance) / 1e9).toFixed(2)} TON</b>\n\n` +
            `${e('🔒')} Your mnemonic is stored in memory only.`,
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
    await ctx.reply(
        `${e('✅')} Wallet disconnected.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🏠 Menu', 'menu_main') }
    );
});

bot.command('create', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `${e('❌')} <b>Invalid format</b>\n\n` +
            `Usage:\n<code>/create budget description</code>\n\n` +
            `Example: <code>/create 5 Write a bot</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const budgetTon = args[0];
    if (isNaN(Number(budgetTon)) || Number(budgetTon) <= 0) {
        return ctx.reply(`${e('❌')} Budget must be a positive number.`, { parse_mode: 'HTML' });
    }

    const w = await requireWallet(ctx);
    if (!w) return;

    const description = args.slice(1).join(' ');

    try {
        await ctx.reply(`${e('⏳')} Creating job...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const descHash = BigInt('0x' + Buffer.from(description).toString('hex').padEnd(64, '0').slice(0, 64));

        const body = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(w.wallet.address)
            .storeCoins(toNano(budgetTon))
            .storeUint(descHash, 256)
            .storeUint(86400, 32)
            .storeUint(86400, 32)
            .endCell();

        await sendTx(client, w, Address.parse(FACTORY_ADDRESS), toNano('0.15'), body);

        const jobCount = await getFactoryJobCount(client, FACTORY_ADDRESS);
        const jobId = jobCount - 1;
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);

        const kb = new InlineKeyboard()
            .text('🪙 Fund Job', `fund_${jobId}`)
            .text('🔭 Status', `status_${jobId}`).row()
            .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `${e('✅')} <b>Job Created!</b>\n\n` +
            `${e('🆔')} ID: <code>${jobId}</code>\n` +
            `${e('🪙')} Budget: <b>${budgetTon} TON</b>\n` +
            `${e('📄')} Description: ${description}\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>\n\n` +
            `Press "Fund Job" to deposit TON into escrow.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
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
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

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
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🪙 Fund Job', `fund_${jobId}`)
            .text('🔭 Status', `status_${jobId}`);

        await ctx.reply(
            `${e('✅')} Budget for job #${jobId} set to <b>${amountTon} TON</b>`,
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
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply(`${e('❌')} Usage: <code>/status job_id</code>`, { parse_mode: 'HTML' });
    await handleStatus(ctx, jobId);
});

bot.command('jobs', async (ctx) => handleJobs(ctx));

// ────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────

async function handleWallet(ctx: any) {
    const userId = getUserId(ctx);
    const mnemonic = userWallets.get(userId);

    if (!mnemonic) {
        const kb = new InlineKeyboard()
            .text('🔗 Connect Wallet', 'menu_connect').row()
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
        const w = await createWalletFromMnemonic(client, mnemonic);
        const balance = await client.getBalance(w.wallet.address);
        const addr = w.wallet.address.toString();

        const kb = new InlineKeyboard()
            .url('🔗 Explorer', explorerLink(addr))
            .text('🔌 Disconnect', 'menu_disconnect').row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `${e('👛')} <b>Your Wallet</b>\n\n` +
            `${e('📍')} Address:\n<code>${addr}</code>\n\n` +
            `${e('🪙')} Balance: <b>${(Number(balance) / 1e9).toFixed(2)} TON</b>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleFactory(ctx: any) {
    const kb = new InlineKeyboard()
        .url('💎 JobFactory', explorerLink(FACTORY_ADDRESS))
        .url('💰 JettonJobFactory', explorerLink(JETTON_FACTORY_ADDRESS)).row()
        .text('🏠 Main Menu', 'menu_main');

    await ctx.reply(
        `${logo()} <b>ENACT Factories</b>\n` +
        `${e('🌍')} TON Mainnet\n\n` +
        `${e('🪙')} <b>JobFactory</b> (TON payments)\n` +
        `<code>${FACTORY_ADDRESS}</code>\n\n` +
        `${e('💰')} <b>JettonJobFactory</b> (USDT payments)\n` +
        `<code>${JETTON_FACTORY_ADDRESS}</code>`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
}

async function handleJobs(ctx: any) {
    try {
        const client = await createClient();
        const count = await getFactoryJobCount(client, FACTORY_ADDRESS);

        if (count === 0) {
            const kb = new InlineKeyboard()
                .text('✍️ Create First Job', 'menu_create').row()
                .text('🏠 Main Menu', 'menu_main');
            return ctx.reply(`${e('📋')} No jobs yet. Create the first one!`, { parse_mode: 'HTML', reply_markup: kb });
        }

        let text = `${e('📋')} <b>Jobs (${count} total)</b>\n\n`;
        const showCount = Math.min(count, 10);
        const start = count - showCount;

        const stateIcon: Record<string, string> = {
            OPEN: e('🟢'), FUNDED: e('💰'), SUBMITTED: e('📨'),
            COMPLETED: e('✅'), DISPUTED: e('⚠️'), CANCELLED: e('🚫'),
        };

        for (let i = start; i < count; i++) {
            const addr = await getJobAddress(client, FACTORY_ADDRESS, i);
            try {
                const s = await getJobStatus(client, addr.toString());
                const icon = stateIcon[s.stateName] ?? '❓';
                text += `${icon} <b>#${i}</b> — ${s.stateName} | ${fmtTon(s.budget)} TON\n`;
            } catch {
                text += `⬜ <b>#${i}</b> — (not initialized)\n`;
            }
            if (i < count - 1) await new Promise(r => setTimeout(r, 300));
        }

        const kb = new InlineKeyboard();
        const btnStart = Math.max(start, count - 5);
        for (let i = btnStart; i < count; i++) {
            kb.text(`🔭 #${i}`, `status_${i}`);
        }
        kb.row().text('✍️ Create Job', 'menu_create')
          .text('🏠 Menu', 'menu_main');

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleStatus(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const s = await getJobStatus(client, jobAddr.toString());

        const stateIcon: Record<string, string> = {
            OPEN: e('🟢'), FUNDED: e('💰'), SUBMITTED: e('📨'),
            COMPLETED: e('✅'), DISPUTED: e('⚠️'), CANCELLED: e('🚫'),
        };
        const icon = stateIcon[s.stateName] ?? '❓';

        let text =
            `${icon} <b>Job #${s.jobId}</b>\n\n` +
            `${e('📊')} State: <b>${s.stateName}</b>\n` +
            `${e('🪙')} Budget: <b>${fmtTon(s.budget)} TON</b>\n` +
            `${e('👤')} Client: <code>${s.client}</code>\n` +
            `${e('🔧')} Provider: <code>${s.provider}</code>\n` +
            `${e('⚖️')} Evaluator: <code>${s.evaluator}</code>\n` +
            `${e('⏰')} Timeout: ${s.timeout / 3600}h\n` +
            `${e('📍')} Address: <code>${jobAddr.toString()}</code>`;

        const kb = new InlineKeyboard();

        switch (s.stateName) {
            case 'OPEN':
                kb.text('💰 Fund', `fund_${jobId}`)
                  .text('🤝 Take Job', `take_${jobId}`);
                break;
            case 'FUNDED':
                kb.text('🤝 Take Job', `take_${jobId}`)
                  .text('🚫 Cancel', `cancel_${jobId}`);
                break;
            case 'SUBMITTED':
                kb.text('✅ Approve', `approve_${jobId}`)
                  .text('❌ Reject', `reject_${jobId}`).row()
                  .text('⏰ Claim (timeout)', `claim_${jobId}`);
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
    const w = await requireWallet(ctx);
    if (!w) return;

    try {
        await ctx.reply(`${e('⏳')} Funding job #${jobId}...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const status = await getJobStatus(client, jobAddr.toString());

        const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        const amount = status.budget + toNano('0.1');
        await sendTx(client, w, jobAddr, amount, body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('💰')} <b>Job #${jobId} Funded!</b>\n\n` +
            `${e('🪙')} Amount: <b>${fmtTon(status.budget)} TON</b>\n` +
            `Funds are in escrow. Waiting for a provider.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleTake(ctx: any, jobId: number) {
    const w = await requireWallet(ctx);
    if (!w) return;

    try {
        await ctx.reply(`${e('⏳')} Taking job #${jobId}...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.takeJob, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('🤝')} <b>Job #${jobId} Taken!</b>\n\n` +
            `Complete the work and submit your result:\n` +
            `<code>/submit ${jobId} your_result_text</code>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleCancel(ctx: any, jobId: number) {
    const w = await requireWallet(ctx);
    if (!w) return;

    try {
        await ctx.reply(`${e('⏳')} Cancelling job #${jobId}...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.cancel, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('🚫')} <b>Job #${jobId} Cancelled</b>\n\nFunds refunded to the client.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleClaim(ctx: any, jobId: number) {
    const w = await requireWallet(ctx);
    if (!w) return;

    try {
        await ctx.reply(`${e('⏳')} Claiming funds for #${jobId}...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.claim, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('⏰')} <b>Job #${jobId} Claimed!</b>\n\nEvaluator timed out — funds sent to the provider.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleQuit(ctx: any, jobId: number) {
    const w = await requireWallet(ctx);
    if (!w) return;

    try {
        await ctx.reply(`${e('⏳')} Quitting job #${jobId}...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell().storeUint(JobOpcodes.quit, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `${e('🚪')} <b>Quit Job #${jobId}</b>\n\nJob is open again for other providers.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (err: any) {
        await ctx.reply(`${e('❌')} Error: ${err.message}`, { parse_mode: 'HTML' });
    }
}

async function handleEvaluate(ctx: any, jobId: number, approved: boolean) {
    const w = await requireWallet(ctx);
    if (!w) return;

    try {
        await ctx.reply(`${e('⏳')} ${approved ? 'Approving' : 'Rejecting'} job #${jobId}...`, { parse_mode: 'HTML' });
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(0n, 256)
            .endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔭 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        if (approved) {
            await ctx.reply(
                `${e('✅')} <b>Job #${jobId} Approved!</b>\n\nFunds sent to the provider. ${e('🎉')}`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        } else {
            await ctx.reply(
                `${e('❌')} <b>Job #${jobId} Rejected</b>\n\nFunds refunded to the client.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }
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
        `  /connect — Connect your wallet (24-word mnemonic)\n` +
        `  /disconnect — Disconnect wallet\n` +
        `  /wallet — Wallet info & balance\n\n` +
        `<b>${e('👤')} For Clients:</b>\n` +
        `  /create — Create a new job\n` +
        `  /fund — Fund a job with TON\n` +
        `  /budget — Change job budget\n` +
        `  /approve — Approve submitted result\n` +
        `  /reject — Reject submitted result\n` +
        `  /cancel — Cancel after timeout\n\n` +
        `<b>${e('🔧')} For Providers:</b>\n` +
        `  /take — Take an open job\n` +
        `  /submit — Submit your result\n` +
        `  /claim — Claim funds (eval timeout)\n` +
        `  /quit — Quit before submitting\n\n` +
        `<b>${e('🔭')} Info:</b>\n` +
        `  /status — Check job status\n` +
        `  /jobs — List all jobs\n` +
        `  /factory — Factory contract addresses\n\n` +
        `${e('💡')} Job lifecycle:\n` +
        `${e('🟢')} OPEN → ${e('💰')} FUNDED → ${e('📨')} SUBMITTED → ${e('✅')} COMPLETED`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
}

// ─── Start ───
async function main() {
    await loadCustomEmoji();
    bot.start();
    console.log('ENACT Protocol bot started');
}

main();
