import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { Address, beginCell, toNano } from '@ton/core';
import {
    createClient, createWallet, sendTx,
    getJobStatus, getFactoryJobCount, getJobAddress,
    FactoryOpcodes, JobOpcodes,
} from './utils';

const BOT_TOKEN = process.env.BOT_TOKEN;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;

if (!BOT_TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1); }
if (!FACTORY_ADDRESS) { console.error('FACTORY_ADDRESS not set'); process.exit(1); }

const bot = new Bot(BOT_TOKEN);

// ─── State icons ───
const stateEmoji: Record<string, string> = {
    OPEN: '🟢', FUNDED: '💰', SUBMITTED: '📨',
    COMPLETED: '✅', DISPUTED: '⚠️', CANCELLED: '🚫',
};

function fmtTon(nanotons: string): string {
    return (Number(BigInt(nanotons)) / 1e9).toFixed(2);
}

function explorerLink(addr: string): string {
    return `https://tonviewer.com/${addr}`;
}

// ────────────────────────────────────────────
// /start — Main menu
// ────────────────────────────────────────────
bot.command('start', async (ctx) => {
    const kb = new InlineKeyboard()
        .text('📝 Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('🔍 Job Status', 'menu_status')
        .text('💼 Wallet', 'menu_wallet').row()
        .text('📖 Help', 'menu_help');

    await ctx.reply(
        `🤖 <b>ENACT Protocol</b>\n\n` +
        `Secure escrow for AI agent jobs on TON.\n` +
        `Choose an action:`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

// ────────────────────────────────────────────
// Callback queries — menu
// ────────────────────────────────────────────
bot.callbackQuery('menu_create', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `📝 <b>Create a Job</b>\n\n` +
        `Send the command:\n` +
        `<code>/create budget description</code>\n\n` +
        `Example:\n` +
        `<code>/create 5 Write a smart contract</code>\n\n` +
        `💡 Budget is in TON. The job will be created in OPEN state.`,
        { parse_mode: 'HTML' }
    );
});

bot.callbackQuery('menu_jobs', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('⏳ Loading jobs...');
    await handleJobs(ctx);
});

bot.callbackQuery('menu_status', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `🔍 <b>Check Job Status</b>\n\n` +
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

bot.callbackQuery('menu_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showHelp(ctx);
});

bot.callbackQuery('menu_main', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
        .text('📝 Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('🔍 Job Status', 'menu_status')
        .text('💼 Wallet', 'menu_wallet').row()
        .text('📖 Help', 'menu_help');

    await ctx.reply(
        `🤖 <b>ENACT Protocol</b>\n\nChoose an action:`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

// ────────────────────────────────────────────
// Action callbacks (from job status buttons)
// ────────────────────────────────────────────
bot.callbackQuery(/^fund_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await ctx.reply(`⏳ Funding job #${jobId}...`);
    await handleFund(ctx, jobId);
});

bot.callbackQuery(/^take_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await ctx.reply(`⏳ Taking job #${jobId}...`);
    await handleTake(ctx, jobId);
});

bot.callbackQuery(/^cancel_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await ctx.reply(`⏳ Cancelling job #${jobId}...`);
    await handleCancel(ctx, jobId);
});

bot.callbackQuery(/^claim_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await ctx.reply(`⏳ Claiming funds for #${jobId}...`);
    await handleClaim(ctx, jobId);
});

bot.callbackQuery(/^quit_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await ctx.reply(`⏳ Quitting job #${jobId}...`);
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
    await ctx.reply(`⏳ Approving job #${jobId}...`);
    await handleEvaluate(ctx, jobId, true);
});

bot.callbackQuery(/^reject_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const jobId = parseInt(ctx.match![1]);
    await ctx.reply(`⏳ Rejecting job #${jobId}...`);
    await handleEvaluate(ctx, jobId, false);
});

// ────────────────────────────────────────────
// Text commands
// ────────────────────────────────────────────
bot.command('help', async (ctx) => showHelp(ctx));
bot.command('wallet', async (ctx) => handleWallet(ctx));

bot.command('create', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `❌ <b>Invalid format</b>\n\n` +
            `Usage:\n<code>/create budget description</code>\n\n` +
            `Example: <code>/create 5 Write a bot</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const budgetTon = args[0];
    const description = args.slice(1).join(' ');

    try {
        await ctx.reply('⏳ Creating job...');
        const client = await createClient();
        const w = await createWallet(client);
        const descHash = BigInt('0x' + Buffer.from(description).toString('hex').padEnd(64, '0').slice(0, 64));

        const body = beginCell()
            .storeUint(FactoryOpcodes.createJob, 32)
            .storeAddress(w.wallet.address)
            .storeCoins(toNano(budgetTon))
            .storeUint(descHash, 256)
            .storeUint(86400, 32)
            .storeUint(86400, 32)
            .endCell();

        await sendTx(client, w, Address.parse(FACTORY_ADDRESS!), toNano('0.15'), body);

        const jobCount = await getFactoryJobCount(client, FACTORY_ADDRESS!);
        const jobId = jobCount - 1;
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);

        const kb = new InlineKeyboard()
            .text('💰 Fund Job', `fund_${jobId}`)
            .text('🔍 Status', `status_${jobId}`).row()
            .url('🔗 Explorer', explorerLink(jobAddr.toString())).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `✅ <b>Job Created!</b>\n\n` +
            `🆔 ID: <code>${jobId}</code>\n` +
            `💎 Budget: <b>${budgetTon} TON</b>\n` +
            `📄 Description: ${description}\n` +
            `📍 Address: <code>${jobAddr.toString()}</code>\n\n` +
            `Press "Fund Job" to deposit TON into escrow.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
});

bot.command('fund', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/fund job_id</code>', { parse_mode: 'HTML' });
    await handleFund(ctx, jobId);
});

bot.command('take', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/take job_id</code>', { parse_mode: 'HTML' });
    await handleTake(ctx, jobId);
});

bot.command('submit', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
        return ctx.reply(
            `❌ <b>Invalid format</b>\n\nUsage:\n<code>/submit job_id result_text</code>`,
            { parse_mode: 'HTML' }
        );
    }

    const jobId = parseInt(args[0]);
    const resultText = args.slice(1).join(' ');
    const resultHash = BigInt('0x' + Buffer.from(resultText).toString('hex').padEnd(64, '0').slice(0, 64));

    try {
        await ctx.reply('⏳ Submitting result...');
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.submitResult, 32)
            .storeUint(resultHash, 256)
            .storeUint(0, 8)
            .endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `📨 <b>Result Submitted!</b>\n\n` +
            `🆔 Job: #${jobId}\n` +
            `Awaiting evaluation from the evaluator.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
});

bot.command('approve', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/approve job_id</code>', { parse_mode: 'HTML' });
    await handleEvaluate(ctx, jobId, true);
});

bot.command('reject', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/reject job_id</code>', { parse_mode: 'HTML' });
    await handleEvaluate(ctx, jobId, false);
});

bot.command('budget', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) return ctx.reply('❌ Usage: <code>/budget job_id amount_ton</code>', { parse_mode: 'HTML' });

    const jobId = parseInt(args[0]);
    const amountTon = args[1];

    try {
        await ctx.reply('⏳ Updating budget...');
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.setBudget, 32)
            .storeCoins(toNano(amountTon))
            .endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('💰 Fund Job', `fund_${jobId}`)
            .text('🔍 Status', `status_${jobId}`);

        await ctx.reply(
            `✅ Budget for job #${jobId} set to <b>${amountTon} TON</b>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
});

bot.command('cancel', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/cancel job_id</code>', { parse_mode: 'HTML' });
    await handleCancel(ctx, jobId);
});

bot.command('claim', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/claim job_id</code>', { parse_mode: 'HTML' });
    await handleClaim(ctx, jobId);
});

bot.command('quit', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/quit job_id</code>', { parse_mode: 'HTML' });
    await handleQuit(ctx, jobId);
});

bot.command('status', async (ctx) => {
    const jobId = parseInt(ctx.message?.text?.split(' ')[1] ?? '');
    if (isNaN(jobId)) return ctx.reply('❌ Usage: <code>/status job_id</code>', { parse_mode: 'HTML' });
    await handleStatus(ctx, jobId);
});

bot.command('jobs', async (ctx) => handleJobs(ctx));

// ────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────

async function handleWallet(ctx: any) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const balance = await client.getBalance(w.wallet.address);
        const addr = w.wallet.address.toString();

        const kb = new InlineKeyboard()
            .url('🔗 Explorer', explorerLink(addr)).row()
            .text('🏠 Main Menu', 'menu_main');

        await ctx.reply(
            `💼 <b>Bot Wallet</b>\n\n` +
            `📍 Address:\n<code>${addr}</code>\n\n` +
            `💎 Balance: <b>${(Number(balance) / 1e9).toFixed(2)} TON</b>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleJobs(ctx: any) {
    try {
        const client = await createClient();
        const count = await getFactoryJobCount(client, FACTORY_ADDRESS!);

        if (count === 0) {
            const kb = new InlineKeyboard()
                .text('📝 Create First Job', 'menu_create').row()
                .text('🏠 Main Menu', 'menu_main');
            return ctx.reply('📋 No jobs yet. Create the first one!', { reply_markup: kb });
        }

        let text = `📋 <b>Jobs (${count} total)</b>\n\n`;
        const showCount = Math.min(count, 10);
        const start = count - showCount;

        for (let i = start; i < count; i++) {
            const addr = await getJobAddress(client, FACTORY_ADDRESS!, i);
            try {
                const s = await getJobStatus(client, addr.toString());
                const emoji = stateEmoji[s.stateName] ?? '❓';
                text += `${emoji} <b>#${i}</b> — ${s.stateName} | ${fmtTon(s.budget)} TON\n`;
            } catch {
                text += `⬜ <b>#${i}</b> — (not initialized)\n`;
            }
            if (i < count - 1) await new Promise(r => setTimeout(r, 300));
        }

        const kb = new InlineKeyboard();
        const btnStart = Math.max(start, count - 5);
        for (let i = btnStart; i < count; i++) {
            kb.text(`🔍 #${i}`, `status_${i}`);
        }
        kb.row().text('📝 Create Job', 'menu_create')
          .text('🏠 Menu', 'menu_main');

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleStatus(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const s = await getJobStatus(client, jobAddr.toString());
        const emoji = stateEmoji[s.stateName] ?? '❓';

        let text =
            `${emoji} <b>Job #${s.jobId}</b>\n\n` +
            `📊 State: <b>${s.stateName}</b>\n` +
            `💎 Budget: <b>${fmtTon(s.budget)} TON</b>\n` +
            `👤 Client: <code>${s.client}</code>\n` +
            `🔧 Provider: <code>${s.provider}</code>\n` +
            `⚖️ Evaluator: <code>${s.evaluator}</code>\n` +
            `⏱ Timeout: ${s.timeout / 3600}h\n` +
            `📍 Address: <code>${jobAddr.toString()}</code>`;

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
                text += `\n\n🎉 Job completed!`;
                break;
            case 'CANCELLED':
                text += `\n\n🚫 Job cancelled.`;
                break;
        }

        kb.row()
          .url('🔗 Explorer', explorerLink(jobAddr.toString()))
          .text('🏠 Menu', 'menu_main');

        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleFund(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const status = await getJobStatus(client, jobAddr.toString());

        const body = beginCell().storeUint(JobOpcodes.fund, 32).endCell();
        const amount = BigInt(status.budget) + toNano('0.1');
        await sendTx(client, w, jobAddr, amount, body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `💰 <b>Job #${jobId} Funded!</b>\n\n` +
            `💎 Amount: <b>${fmtTon(status.budget)} TON</b>\n` +
            `Funds are in escrow. Waiting for a provider.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleTake(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell().storeUint(JobOpcodes.takeJob, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `🤝 <b>Job #${jobId} Taken!</b>\n\n` +
            `Complete the work and submit your result:\n` +
            `<code>/submit ${jobId} your_result_text</code>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleCancel(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell().storeUint(JobOpcodes.cancel, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `🚫 <b>Job #${jobId} Cancelled</b>\n\n` +
            `Funds refunded to the client.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleClaim(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell().storeUint(JobOpcodes.claim, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `⏰ <b>Job #${jobId} Claimed!</b>\n\n` +
            `Evaluator timed out — funds sent to the provider.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleQuit(ctx: any, jobId: number) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell().storeUint(JobOpcodes.quit, 32).endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        await ctx.reply(
            `🚪 <b>Quit Job #${jobId}</b>\n\n` +
            `Job is open again for other providers.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function handleEvaluate(ctx: any, jobId: number, approved: boolean) {
    try {
        const client = await createClient();
        const w = await createWallet(client);
        const jobAddr = await getJobAddress(client, FACTORY_ADDRESS!, jobId);
        const body = beginCell()
            .storeUint(JobOpcodes.evaluate, 32)
            .storeUint(approved ? 1 : 0, 8)
            .storeUint(0n, 256)
            .endCell();
        await sendTx(client, w, jobAddr, toNano('0.05'), body);

        const kb = new InlineKeyboard()
            .text('🔍 Status', `status_${jobId}`)
            .text('🏠 Menu', 'menu_main');

        if (approved) {
            await ctx.reply(
                `✅ <b>Job #${jobId} Approved!</b>\n\n` +
                `Funds sent to the provider. 🎉`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        } else {
            await ctx.reply(
                `❌ <b>Job #${jobId} Rejected</b>\n\n` +
                `Funds refunded to the client.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }
    } catch (e: any) {
        await ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function showHelp(ctx: any) {
    const kb = new InlineKeyboard()
        .text('📝 Create Job', 'menu_create')
        .text('📋 Browse Jobs', 'menu_jobs').row()
        .text('💼 Wallet', 'menu_wallet')
        .text('🏠 Menu', 'menu_main');

    await ctx.reply(
        `📖 <b>Help — ENACT Protocol Bot</b>\n\n` +
        `<b>👤 For Clients:</b>\n` +
        `  /create — Create a new job\n` +
        `  /fund — Fund a job with TON\n` +
        `  /budget — Change job budget\n` +
        `  /approve — Approve submitted result\n` +
        `  /reject — Reject submitted result\n` +
        `  /cancel — Cancel after timeout\n\n` +
        `<b>🔧 For Providers:</b>\n` +
        `  /take — Take an open job\n` +
        `  /submit — Submit your result\n` +
        `  /claim — Claim funds (eval timeout)\n` +
        `  /quit — Quit before submitting\n\n` +
        `<b>ℹ️ Info:</b>\n` +
        `  /status — Check job status\n` +
        `  /jobs — List all jobs\n` +
        `  /wallet — Bot wallet info\n\n` +
        `💡 Job lifecycle:\n` +
        `🟢 OPEN → 💰 FUNDED → 📨 SUBMITTED → ✅ COMPLETED`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
}

bot.start();
console.log('🤖 ENACT Protocol bot started');
