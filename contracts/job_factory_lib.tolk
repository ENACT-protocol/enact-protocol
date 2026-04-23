tolk 1.3

import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"
import "lib/constants.tolk"

// ===================== CONSTANTS =====================

// Factory-only error codes (200s range). ERR_ACCESS_DENIED,
// ERR_WRONG_MODE etc. come from lib/constants.tolk.
const ERR_INVALID_TIMEOUT: int = 202;
const ERR_OVERFLOW: int = 203;

const MIN_TIMEOUT: int = 3600;      // Min 1 hour
const MAX_TIMEOUT: int = 2592000;   // Max 30 days

// AppMode window minimum matches the job timeout floor — anything
// shorter is a UX anti-pattern (providers can't realistically bid in
// under an hour) and the maximum is the same 30-day ceiling so we
// cannot outlive the job itself. A FIXED job ignores these bounds.
const MIN_APP_WINDOW: int = 3600;
const MAX_APP_WINDOW: int = 2592000;

// ===================== STORAGE =====================

// v2-lib factory: same feature set as v2-opt, but the jobCode is
// stored as a 256-bit hash instead of the full code cell. Children
// are deployed with an exotic library-ref cell as their code
// (type 2, 33 bytes total) which is resolved by the TVM through the
// global masterchain library registry populated by CodeLibrary.
// version() reports 4 (same logical protocol version); deployments
// are tagged in file names (mainnet-v2-lib.json) so the previous
// v2-opt (inline-code) factory remains addressable.
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

// CRC-32 opcodes to match the child job contract scheme.

// V2 init params ride in a plain ref cell so both CreateJob and InitJob
// stay under 1023 bits. Layout inside the ref:
//   mode:uint8 (8)
//   applicationWindow:uint32 (32)
//   hookAddress:(Maybe address) (1 or 1+267)
// The factory forwards the same ref to InitJob unmodified, so the ref
// cell hash matches on both sides and the job contract parses it
// without re-serialization.

// 0x8204df3b = CRC32("op::create_job")
struct (0x8204df3b) CreateJob {
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
    v2Ref: cell;
}

// 0xbb8c8df3 = CRC32("op::init_job") — must match job.tolk struct
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
    // Empty v2Cell: MODE_FIXED (0), applicationDeadline 0, no hook (false bit).
    val emptyV2 = beginCell()
        .storeUint(0, 8)     // mode = MODE_FIXED (placeholder)
        .storeUint(0, 32)    // applicationDeadline
        .storeBool(false)    // no hookAddress
        .endCell();

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
        .storeRef(emptyV2)                     // v2 ref
        .endCell();

    val emptyJobData = beginCell()
        .storeUint(jobId, 32)                  // jobId
        .storeAddress(contract.getAddress())  // factoryAddress
        .storeAddress(contract.getAddress())  // clientAddress placeholder
        .storeBool(false)                       // providerAddress = null
        .storeUint(0, 8)                        // state = OPEN
        .storeRef(emptyDetails)                 // details ref
        .endCell();

    // v2-lib: child's code is an exotic library-ref cell — 8 bits of
    // type tag (0x02 = LibraryReference) plus the 256-bit hash of the
    // actual bytecode published on masterchain. TVM resolves the ref
    // transparently at execution time, so the contract behaves exactly
    // like an inline-code deploy, at a fraction of the storage cost.
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
            // Peek at mode + applicationWindow without consuming the ref
            // so it can be forwarded to InitJob byte-identical.
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
