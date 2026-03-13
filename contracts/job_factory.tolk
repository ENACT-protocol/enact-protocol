tolk 1.2

import "@stdlib/gas-payments"

// ===================== CONSTANTS =====================

const ERR_ACCESS_DENIED: int = 200;
const ERR_INVALID_FEE: int = 201;
const ERR_INVALID_TIMEOUT: int = 202;
const ERR_OVERFLOW: int = 203;

const MAX_FEE_BPS: int = 1000;  // Max 10% fee cap — prevents abuse
const MIN_TIMEOUT: int = 3600;      // Min 1 hour
const MAX_TIMEOUT: int = 2592000;   // Max 30 days

// ===================== STORAGE =====================

struct FactoryStorage {
    owner: address;
    jobCode: cell;
    nextJobId: uint32;
    protocolFeeBps: uint16;
    feeCollector: address;
}

fun FactoryStorage.load(): FactoryStorage {
    return FactoryStorage.fromCell(contract.getData());
}

fun FactoryStorage.save(self) {
    contract.setData(self.toCell());
}

// ===================== MESSAGES =====================

struct (0x00000010) CreateJob {
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
}

@overflow1023_policy("suppress")
struct (0x00000006) InitJob {
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
        .storeBool(false)                       // providerAddress = null (Maybe)
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

            // Deploy child Job contract
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
    return 2;
}

