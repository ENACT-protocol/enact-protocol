import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Address, beginCell } from '@ton/core';
import { JettonJob, JettonJobOpcodes } from '../wrappers/JettonJob';
import { JobFactory } from '../wrappers/JobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('JettonJob', () => {
    let jettonJobCode: Cell;
    let jettonFactoryCode: Cell;

    beforeAll(async () => {
        jettonJobCode = await compile('JettonJob');
        jettonFactoryCode = await compile('JettonJobFactory');
    }, 30000);

    let blockchain: Blockchain;
    let factory: SandboxContract<JobFactory>;
    let client: SandboxContract<TreasuryContract>;
    let provider: SandboxContract<TreasuryContract>;
    let evaluator: SandboxContract<TreasuryContract>;
    let outsider: SandboxContract<TreasuryContract>;
    let jettonWalletTreasury: SandboxContract<TreasuryContract>;

    const TIMEOUT = 86400; // 24h
    const EVAL_TIMEOUT = 86400; // 24h
    const BUDGET = 5000000000n; // 5 USDT (6 decimals)
    const DESC_HASH = BigInt('0x' + 'a'.repeat(64));
    const RESULT_HASH = BigInt('0x' + 'b'.repeat(64));
    const REASON_HASH = BigInt('0x' + 'c'.repeat(64));

    async function deployFactoryAndCreateJob(budget?: bigint) {
        factory = blockchain.openContract(
            JobFactory.createFromConfig(
                { owner: client.address, jobCode: jettonJobCode },
                jettonFactoryCode
            )
        );

        await factory.sendDeploy(client.getSender(), toNano('0.1'));

        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: budget ?? BUDGET,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
        });

        const jobAddress = await factory.getJobAddress(0);
        return blockchain.openContract(JettonJob.createFromAddress(jobAddress));
    }

    async function setupJob(budget?: bigint) {
        const job = await deployFactoryAndCreateJob(budget);
        // Set Jetton wallet
        await job.sendSetJettonWallet(client.getSender(), toNano('0.05'), jettonWalletTreasury.address);
        return job;
    }

    async function fundJob(job: SandboxContract<JettonJob>, amount?: bigint) {
        return job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: amount ?? BUDGET,
            sender: client.address,
        });
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        client = await blockchain.treasury('client');
        provider = await blockchain.treasury('provider');
        evaluator = await blockchain.treasury('evaluator');
        outsider = await blockchain.treasury('outsider');
        jettonWalletTreasury = await blockchain.treasury('jettonWallet');
    });

    // ========== HAPPY PATH ==========

    it('happy path: create → setJettonWallet → fund → take → submit → approve → completed', async () => {
        const job = await setupJob();

        // Fund via Jetton transfer_notification
        const fundResult = await fundJob(job);
        expect(fundResult.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(1); // FUNDED

        // Take
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(1); // still FUNDED

        // Submit
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        expect(await job.getState()).toBe(2); // SUBMITTED

        // Approve
        const approveResult = await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        // Now in SETTLING_COMPLETED until recipient commits.
        expect(await job.getState()).toBe(6); // SETTLING_COMPLETED
        await job.sendCommitSettlement(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(3); // COMPLETED

        // Verify Jetton transfer was sent to jettonWallet (payout to provider)
        expect(approveResult.transactions).toHaveTransaction({
            from: job.address,
            to: jettonWalletTreasury.address,
            success: true,
        });
    });

    it('reject path: fund → take → submit → reject → disputed, Jetton refund to client', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const rejectResult = await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), false);
        expect(await job.getState()).toBe(7); // SETTLING_DISPUTED
        await job.sendCommitSettlement(client.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(4); // DISPUTED

        // Verify Jetton transfer sent (refund to client via jettonWallet)
        expect(rejectResult.transactions).toHaveTransaction({
            from: job.address,
            to: jettonWalletTreasury.address,
            success: true,
        });
    });

    it('cancel path: fund → timeout → cancel → Jetton refund to client', async () => {
        const job = await setupJob();
        await fundJob(job);

        // Advance past timeout
        blockchain.now = Math.floor(Date.now() / 1000) + TIMEOUT + 1;

        const cancelResult = await job.sendCancel(client.getSender(), toNano('0.15'));
        expect(await job.getState()).toBe(8); // SETTLING_CANCELLED
        await job.sendCommitSettlement(client.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(5); // CANCELLED

        // Verify Jetton refund sent
        expect(cancelResult.transactions).toHaveTransaction({
            from: job.address,
            to: jettonWalletTreasury.address,
            success: true,
        });
    });

    // ========== JETTON WALLET SETUP ==========

    it('should set jetton wallet address', async () => {
        const job = await deployFactoryAndCreateJob();

        const result = await job.sendSetJettonWallet(client.getSender(), toNano('0.05'), jettonWalletTreasury.address);
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });

        const data = await job.getJobData();
        expect(data.jettonWallet.equals(jettonWalletTreasury.address)).toBe(true);
    });

    it('should reject setJettonWallet from non-client', async () => {
        const job = await deployFactoryAndCreateJob();

        const result = await job.sendSetJettonWallet(outsider.getSender(), toNano('0.05'), jettonWalletTreasury.address);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject setJettonWallet when not OPEN', async () => {
        const job = await setupJob();
        await fundJob(job);

        const result = await job.sendSetJettonWallet(client.getSender(), toNano('0.05'), outsider.address);
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    // ========== JETTON FUNDING ==========

    it('should reject fund from wrong jetton wallet', async () => {
        const job = await setupJob();

        // Send transfer_notification from outsider (not the jetton wallet)
        const result = await job.sendTransferNotification(outsider.getSender(), toNano('0.1'), {
            amount: BUDGET,
            sender: client.address,
        });
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject fund with insufficient Jetton amount', async () => {
        const job = await setupJob();

        const result = await fundJob(job, BUDGET - 1n);
        expect(result.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
    });

    it('should reject fund from non-client sender', async () => {
        const job = await setupJob();

        // transfer_notification from correct jetton wallet but sender is not client
        const result = await job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: BUDGET,
            sender: outsider.address, // not the client
        });
        expect(result.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject fund when jetton wallet not set', async () => {
        const job = await deployFactoryAndCreateJob(); // no setJettonWallet

        // Send from some address — won't match the placeholder
        const result = await job.sendTransferNotification(outsider.getSender(), toNano('0.1'), {
            amount: BUDGET,
            sender: client.address,
        });
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            exitCode: 100, // ERR_ACCESS_DENIED (sender != jettonWallet placeholder)
        });
    });

    it('should reject fund when budget is 0', async () => {
        const job = await setupJob(0n);

        const result = await fundJob(job, 1000n);
        expect(result.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            exitCode: 106, // ERR_BUDGET_NOT_SET
        });
    });

    // ========== SET BUDGET + FUND ==========

    it('should fund after setBudget', async () => {
        const job = await setupJob(0n); // budget = 0

        // Set budget
        await job.sendSetBudget(client.getSender(), toNano('0.05'), BUDGET);
        const data = await job.getJobData();
        expect(data.budget).toBe(BUDGET);

        // Fund
        await fundJob(job);
        expect(await job.getState()).toBe(1); // FUNDED
    });

    // ========== AUTO-CLAIM ==========

    it('should allow provider to claim after evaluation timeout', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        // Advance past eval timeout
        const jobData = await job.getJobData();
        blockchain.now = jobData.submittedAt + EVAL_TIMEOUT + 1;

        const claimResult = await job.sendClaim(provider.getSender(), toNano('0.15'));
        expect(await job.getState()).toBe(6); // SETTLING_COMPLETED
        await job.sendCommitSettlement(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(3); // COMPLETED

        // Verify Jetton payout sent
        expect(claimResult.transactions).toHaveTransaction({
            from: job.address,
            to: jettonWalletTreasury.address,
            success: true,
        });
    });

    it('should reject claim before evaluation timeout', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const result = await job.sendClaim(provider.getSender(), toNano('0.15'));
        expect(result.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            exitCode: 105, // ERR_EVAL_TIMEOUT_NOT_EXPIRED
        });
    });

    // ========== QUIT ==========

    it('should allow provider to quit before submit', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        await job.sendQuit(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(1); // FUNDED (reopened)

        const data = await job.getJobData();
        expect(data.providerAddress).toBeNull();
    });

    // ========== RESULT TYPE ==========

    it('should store result type on submit', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH, 2); // IPFS
        const data = await job.getJobData();
        expect(data.resultType).toBe(2);
    });

    // ========== REASON ==========

    it('should store reason on evaluate', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true, REASON_HASH);
        const data = await job.getJobData();
        expect(data.reason).toBe(REASON_HASH);
    });

    // ========== JETTON PAYOUT VERIFICATION ==========

    it('should send correct Jetton transfer on approve', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const approveResult = await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);

        // Check the outgoing message to jetton wallet contains correct transfer op
        const outMsgs = approveResult.transactions.filter(
            tx => tx.inMessage?.info.type === 'internal' &&
                  tx.inMessage?.info.src.equals(job.address) &&
                  tx.inMessage?.info.dest.equals(jettonWalletTreasury.address)
        );
        expect(outMsgs.length).toBe(1);

        // Verify the body starts with Jetton transfer op
        const body = outMsgs[0].inMessage!.body.beginParse();
        const op = body.loadUint(32);
        expect(op).toBe(0x0f8a7ea5); // Jetton transfer op

        const queryId = body.loadUint(64);
        const amount = body.loadCoins();
        const dest = body.loadAddress();

        expect(amount).toBe(BUDGET);
        expect(dest.equals(provider.address)).toBe(true);
    });

    it('should send Jetton refund to client on reject', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const rejectResult = await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), false);

        const outMsgs = rejectResult.transactions.filter(
            tx => tx.inMessage?.info.type === 'internal' &&
                  tx.inMessage?.info.src.equals(job.address) &&
                  tx.inMessage?.info.dest.equals(jettonWalletTreasury.address)
        );
        expect(outMsgs.length).toBe(1);

        const body = outMsgs[0].inMessage!.body.beginParse();
        const op = body.loadUint(32);
        expect(op).toBe(0x0f8a7ea5);

        const queryId = body.loadUint(64);
        const amount = body.loadCoins();
        const dest = body.loadAddress();

        expect(amount).toBe(BUDGET);
        expect(dest.equals(client.address)).toBe(true);
    });

    // ========== SECURITY ==========

    it('should reject submit from non-provider', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        const result = await job.sendSubmitResult(outsider.getSender(), toNano('0.05'), RESULT_HASH);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            exitCode: 100,
        });
    });

    it('should reject evaluate from non-evaluator', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const result = await job.sendEvaluate(outsider.getSender(), toNano('0.15'), true);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            exitCode: 100,
        });
    });

    // ========== BUG-1: TWO-PHASE SETTLEMENT (jetton) ==========

    it('CommitSettlement is rejected outside a SETTLING_* state', async () => {
        const job = await setupJob();
        await fundJob(job);
        // State is FUNDED (1), not SETTLING_*.
        const r = await job.sendCommitSettlement(client.getSender(), toNano('0.05'));
        expect(r.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    it('RetryTransfer is rejected outside a SETTLING_* state', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        const r = await job.sendRetryTransfer(provider.getSender(), toNano('0.15'));
        expect(r.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    it('RetryTransfer in SETTLING_COMPLETED is rejected for non-recipients', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        // State is SETTLING_COMPLETED. Outsider is not the provider.
        const r = await job.sendRetryTransfer(outsider.getSender(), toNano('0.15'));
        expect(r.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('CommitSettlement is rejected for non-recipients', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        // State is SETTLING_COMPLETED. Only the provider may commit.
        const r = await job.sendCommitSettlement(outsider.getSender(), toNano('0.05'));
        expect(r.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('EmergencyReclaim is rejected before TIMEOUT_BYPASS', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        // State is SETTLING_COMPLETED. Bypass not yet allowed.
        const r = await job.sendEmergencyReclaim(client.getSender(), toNano('0.15'));
        expect(r.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 110, // ERR_BYPASS_NOT_ALLOWED
        });
    });

    it('EmergencyReclaim is rejected when called by a non-client', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        const r = await job.sendEmergencyReclaim(outsider.getSender(), toNano('0.15'));
        expect(r.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('EmergencyReclaim succeeds after TIMEOUT_BYPASS and exits to DISPUTED', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        expect(await job.getState()).toBe(6); // SETTLING_COMPLETED

        // Fast-forward past the 30-day bypass timeout.
        blockchain.now = Math.floor(Date.now() / 1000) + 2592000 + 100;

        const r = await job.sendEmergencyReclaim(client.getSender(), toNano('0.15'));
        expect(r.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(4); // DISPUTED (permanent exit)
    });

    it('After CommitSettlement finalizes COMPLETED, RetryTransfer is no longer allowed', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.15'), true);
        await job.sendCommitSettlement(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(3); // COMPLETED

        const r = await job.sendRetryTransfer(provider.getSender(), toNano('0.15'));
        expect(r.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    // ========== BUG-2: evaluator cannot be provider ==========

    it('TakeJob is rejected when sender equals the configured evaluator', async () => {
        const job = await setupJob();
        await fundJob(job);

        const r = await job.sendTakeJob(evaluator.getSender(), toNano('0.05'));
        expect(r.transactions).toHaveTransaction({
            from: evaluator.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
        expect(await job.getState()).toBe(1); // still FUNDED, provider unset
    });

    // ========== MIN_GAS guards ==========

    it('EvaluateJob rejects callers who attach less than MIN_GAS_JETTON_PAYOUT', async () => {
        const job = await setupJob();
        await fundJob(job);
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        // Jetton payouts require at least 0.15 TON. 0.1 TON is below the
        // floor; without this guard the jetton_transfer would silently
        // bounce for insufficient forward gas and lock the state terminal.
        const r = await job.sendEvaluate(evaluator.getSender(), toNano('0.1'), true);
        expect(r.transactions).toHaveTransaction({
            from: evaluator.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
    });

    it('TakeJob rejects callers who attach less than MIN_GAS_STATE_CHANGE', async () => {
        const job = await setupJob();
        await fundJob(job);

        const r = await job.sendTakeJob(provider.getSender(), toNano('0.01'));
        expect(r.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
    });

    // ========== CancelJob in OPEN state ==========

    it('cancel in OPEN goes straight to CANCELLED without a jetton payout', async () => {
        const job = await deployFactoryAndCreateJob();
        expect(await job.getState()).toBe(0); // OPEN
        // No jetton wallet set, nothing funded. Client changes their mind.

        const r = await job.sendCancel(client.getSender(), toNano('0.05'));
        expect(r.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(5); // CANCELLED — terminal directly

        // No jetton transfer fired because no jettons were ever received.
        expect(r.transactions).not.toHaveTransaction({
            from: job.address,
            to: jettonWalletTreasury.address,
        });
    });

    it('cancel in OPEN is still client-only', async () => {
        const job = await deployFactoryAndCreateJob();

        const r = await job.sendCancel(outsider.getSender(), toNano('0.05'));
        expect(r.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
        expect(await job.getState()).toBe(0); // still OPEN
    });

    // ========== TransferNotification excess TON return ==========

    it('funding via TransferNotification returns excess TON to the client', async () => {
        const job = await setupJob();

        // The funding message from the (sandbox) jetton wallet carries
        // much more TON than the contract needs to keep. After state is
        // saved we expect the contract to ship everything above the
        // MIN_STORAGE reserve straight back to the original client.
        const r = await job.sendTransferNotification(
            jettonWalletTreasury.getSender(),
            toNano('0.5'),
            { amount: BUDGET, sender: client.address },
        );
        expect(r.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            success: true,
        });
        // An outbound message must land on the client with most of the
        // extra TON — ignore exact value (storage fees, forward fees)
        // and just assert the address match.
        expect(r.transactions).toHaveTransaction({
            from: job.address,
            to: client.address,
            success: true,
        });
    });

    // ========== Exact jetton amount match ==========

    it('TransferNotification rejects an overpaid jetton amount', async () => {
        const job = await setupJob();

        // Client accidentally sends 10 USDT for a 5 USDT job. Previously
        // the 5 USDT excess was stranded on the job jetton wallet with
        // no withdrawal path. Now we reject before state mutates.
        const r = await job.sendTransferNotification(
            jettonWalletTreasury.getSender(),
            toNano('0.1'),
            { amount: BUDGET + 1n, sender: client.address },
        );
        expect(r.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
        expect(await job.getState()).toBe(0); // still OPEN
    });

    it('TransferNotification rejects an underpaid jetton amount', async () => {
        const job = await setupJob();

        const r = await job.sendTransferNotification(
            jettonWalletTreasury.getSender(),
            toNano('0.1'),
            { amount: BUDGET - 1n, sender: client.address },
        );
        expect(r.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
        expect(await job.getState()).toBe(0); // still OPEN
    });
});
