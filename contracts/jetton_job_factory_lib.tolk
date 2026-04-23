tolk 1.3

import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"
import "lib/constants.tolk"

// ===================== CONSTANTS =====================

const ERR_INVALID_TIMEOUT: int = 202;
const ERR_OVERFLOW: int = 203;

const MIN_TIMEOUT: int = 3600;
const MAX_TIMEOUT: int = 2592000;
const MIN_APP_WINDOW: int = 3600;
const MAX_APP_WINDOW: int = 2592000;

// ===================== STORAGE =====================

// v2: see job_factory.tolk for the full rationale. Parallel
// deployment, version() bumped to 4.
// v2-lib: child bytecode comes from the masterchain library registry
// (see contracts/code_library.tolk + scripts/publish-library.ts).
// Storage keeps only the 32-byte hash; calcJobStateInit wraps it into
// an exotic library-ref cell at deploy time.
struct FactoryStorage {
    owner: address;
    jobCodeHash: uint256;
    nextJobId: uint32;
}

fun FactoryStorage.load(): FactoryStorage {
    return FactoryStorage.fromCell(contract.getData());
}

fun FactoryStorage.save(self) {
    contract.setData(self.toCell());
}

// ===================== MESSAGES =====================

// CRC-32 opcodes, same scheme as the TON factory.

// V2 params ride in a plain ref cell. Jetton variant layout:
//   mode:uint8 (8)
//   applicationWindow:uint32 (32)
//   hookAddress:(Maybe address)
//   jettonMaster:(Maybe address)

// 0x8204df3b = CRC32("op::create_job")
struct (0x8204df3b) CreateJob {
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
    v2Ref: cell;
}

// 0xbb8c8df3 = CRC32("op::init_job")
@overflow1023_policy("suppress")
struct (0xbb8c8df3) InitJob {
    jobId: uint32;
    clientAddress: address;
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
    v2Ref: cell;
}

type AllowedMessage =
    | CreateJob

// ===================== CHILD ADDRESS CALCULATION =====================

fun calcJobStateInit(storage: FactoryStorage, jobId: int): AutoDeployAddress {
    // Empty v2Cell: jetton variant. jettonWallet stays in extCell — v2
    // adds mode + deadline + maybe(hook) + maybe(jettonMaster) + pendingBudget.
    val emptyV2 = beginCell()
        .storeUint(0, 8)      // mode = MODE_FIXED (placeholder)
        .storeUint(0, 32)     // applicationDeadline
        .storeBool(false)     // no hookAddress
        .storeBool(false)     // no jettonMaster
        .storeCoins(0)        // pendingBudget
        .endCell();

    val emptyExt = beginCell()
        .storeUint(0, 32)    // timeout
        .storeUint(0, 32)    // createdAt
        .storeUint(0, 32)    // evaluationTimeout
        .storeUint(0, 32)    // submittedAt
        .storeUint(0, 8)     // resultType
        .storeUint(0, 256)   // reason
        .storeAddress(contract.getAddress()) // jettonWallet placeholder
        .endCell();

    val emptyDetails = beginCell()
        .storeAddress(contract.getAddress()) // evaluatorAddress placeholder
        .storeCoins(0)                         // budget
        .storeUint(0, 256)                     // descriptionHash
        .storeUint(0, 256)                     // resultHash
        .storeRef(emptyExt)                    // ext ref
        .storeRef(emptyV2)                     // v2 ref
        .endCell();

    val emptyJobData = beginCell()
        .storeUint(jobId, 32)
        .storeAddress(contract.getAddress())
        .storeAddress(contract.getAddress())
        .storeBool(false)
        .storeUint(0, 8)
        .storeRef(emptyDetails)
        .endCell();

    // v2-lib exotic library-ref code cell — see job_factory.tolk.
    val libRefCode = beginCell()
        .storeUint(2, 8)
        .storeUint(storage.jobCodeHash, 256)
        .endCellSpecial();

    return {
        stateInit: {
            code: libRefCode,
            data: emptyJobData
        }
    };
}

// ===================== HANDLER =====================

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        CreateJob => {
            var storage = lazy FactoryStorage.load();
            assert(msg.timeout >= MIN_TIMEOUT && msg.timeout <= MAX_TIMEOUT) throw ERR_INVALID_TIMEOUT;
            assert(msg.evaluationTimeout >= MIN_TIMEOUT && msg.evaluationTimeout <= MAX_TIMEOUT) throw ERR_INVALID_TIMEOUT;
            var v2s = msg.v2Ref.beginParse();
            val mode = v2s.loadUint(8);
            val applicationWindow = v2s.loadUint(32);
            assert(mode == MODE_FIXED || mode == MODE_APPLICATION) throw ERR_WRONG_MODE;
            if (mode == MODE_APPLICATION) {
                assert(applicationWindow >= MIN_APP_WINDOW && applicationWindow <= MAX_APP_WINDOW) throw ERR_INVALID_TIMEOUT;
            }

            val jobId = storage.nextJobId;
            assert(jobId < 4294967295) throw ERR_OVERFLOW;
            storage.nextJobId = jobId + 1;
            storage.save();

            val deployed = calcJobStateInit(storage, jobId);

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: deployed,
                value: 0,
                body: InitJob {
                    jobId: jobId,
                    clientAddress: in.senderAddress,
                    evaluatorAddress: msg.evaluatorAddress,
                    budget: msg.budget,
                    descriptionHash: msg.descriptionHash,
                    timeout: msg.timeout,
                    evaluationTimeout: msg.evaluationTimeout,
                    v2Ref: msg.v2Ref,
                }
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert(in.body.isEmpty()) throw 0xFFFF;
        }
    }
}

// ===================== BOUNCE HANDLER =====================

fun onBouncedMessage(in: InMessageBounced) {
    // Accept bounced deploy messages silently
}

// ===================== GETTERS =====================

get fun get_job_address(jobId: int): address {
    val storage = FactoryStorage.load();
    return calcJobStateInit(storage, jobId).calculateAddress();
}

get fun get_next_job_id(): int {
    val storage = FactoryStorage.load();
    return storage.nextJobId;
}

get fun version(): int {
    return 4;
}
