tolk 1.3

// ENACT v2-lib: masterchain code-library publisher.
//
// Deployed once per network on the -1 (masterchain) workchain. Its
// only function is to push `action_change_library` out-actions
// (opcode 0x26fa1dd4, mode=2 = public) so that the Job + JettonJob
// bytecodes appear in the global library registry. After that any
// contract on any shard can reference the code through a 33-byte
// exotic library-ref cell (type 2) instead of carrying the full ~3 KB
// bytecode in its stateInit.
//
// Rent economics:
//   Library cells live in the global library dict on masterchain.
//   Rent is ~0.02 TON per KB per year, so a ~3 KB Job library costs
//   ~0.06 TON/year. Fund this contract with ~0.5 TON per library for
//   a ~8-year horizon. Balance can be topped up at any time without a
//   redeploy.
//
// Security:
//   Owner-only. Register mode is restricted to 1 (private — contract
//   can use the library privately) or 2 (public — any contract in the
//   network can reference it). We use mode=2 on deploy; mode=1 is
//   retained for future experimentation but unused in v2-lib flow.
//
// Implementation:
//   Tolk 1.3's stdlib does not expose a high-level wrapper for
//   action_change_library. The workaround uses beginCell/storeRef to
//   construct the out-action body with the prior c5 head as the `prev`
//   ref (TL-B `out_list$_ prev:^(OutList n) action:OutAction`), then
//   two thin asm helpers read/write the TVM c5 control register.

import "@stdlib/gas-payments"

const ERR_ACCESS_DENIED: int = 200;
const ERR_INVALID_MODE: int = 201;

// 0x9c6a0ee4 = CRC32("lib::register")
struct (0x9c6a0ee4) RegisterLibrary {
    mode: uint8;
    libraryCode: cell;
}

type AllowedMessage =
    | RegisterLibrary

struct Storage {
    owner: address;
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

// Read the current head of the action list from c5.
@pure
fun getActionListHead(): cell
    asm "c5 PUSHCTR";

// Write a new action list head cell to c5.
fun setActionListHead(head: cell): void
    asm "c5 POPCTR";

// Append `action_change_library mode:libref_ref` to c5. TL-B:
//   out_list$_ {n:#} prev:^(OutList n) action:OutAction = OutList (n+1);
//   action_change_library#26fa1dd4 mode:(## 7) libref:LibRef = OutAction;
//   libref_ref$1 library:^Cell = LibRef;
// Layout of the new cell:
//   ref 0 = prev c5 head
//   ref 1 = library code
//   data  = 0x26fa1dd4 (32b) + mode (7b) + 1 (1b libref_ref tag)
fun publishLibrary(mode: int, libCode: cell): void {
    val prevC5 = getActionListHead();
    val actionCell = beginCell()
        .storeRef(prevC5)
        .storeUint(0x26fa1dd4, 32)
        .storeUint(mode, 7)
        .storeUint(1, 1)
        .storeRef(libCode)
        .endCell();
    setActionListHead(actionCell);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        RegisterLibrary => {
            val storage = lazy Storage.load();
            assert(in.senderAddress == storage.owner) throw ERR_ACCESS_DENIED;
            // mode 1 = private to this contract, 2 = public (global).
            // v2-lib deploys with mode=2 so basechain factories can
            // reference the code. Allow both values so the owner can
            // experiment; anything else is a caller error.
            assert(msg.mode == 1 || msg.mode == 2) throw ERR_INVALID_MODE;
            publishLibrary(msg.mode, msg.libraryCode);
        }

        else => {
            assert(in.body.isEmpty()) throw 0xFFFF;
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {}

get fun owner(): address {
    return Storage.load().owner;
}
