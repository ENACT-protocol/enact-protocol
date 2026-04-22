tolk 1.3

import "@stdlib/gas-payments"

// ===================== CONSTANTS =====================

const ERR_ACCESS_DENIED: int = 200;
const ERR_INVALID_TIMEOUT: int = 202;
const ERR_OVERFLOW: int = 203;

const MIN_TIMEOUT: int = 3600;
const MAX_TIMEOUT: int = 2592000;

// ===================== STORAGE =====================

// Dead fields (`protocolFeeBps`, `feeCollector`) from the v1 layout
// removed — see job_factory.tolk for the full reasoning. v2 charges
// zero protocol fee by design.
struct FactoryStorage {
    owner: address;
    jobCode: cell;
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

// 0x8204df3b = CRC32("op::create_job")
struct (0x8204df3b) CreateJob {
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
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
}

type AllowedMessage =
    | CreateJob

// ===================== CHILD ADDRESS CALCULATION =====================

fun calcJobStateInit(storage: FactoryStorage, jobId: int): AutoDeployAddress {
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
        .endCell();

    val emptyJobData = beginCell()
        .storeUint(jobId, 32)                  // jobId
        .storeAddress(contract.getAddress())  // factoryAddress
        .storeAddress(contract.getAddress())  // clientAddress placeholder
        .storeBool(false)                       // providerAddress = null
        .storeUint(0, 8)                        // state = OPEN
        .storeRef(emptyDetails)                 // details ref
        .endCell();

    return {
        stateInit: {
            code: storage.jobCode,
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
    return 3;
}

