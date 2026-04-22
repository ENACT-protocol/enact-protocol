tolk 1.3

import "constants.tolk"

// Main-cell storage helpers shared by job.tolk and jetton_job.tolk.
// Details-cell layout differs between TON jobs (10 fields) and jetton
// jobs (11 fields — extra jettonWallet at the end), so detail helpers
// stay in each contract. Main cell is identical across both contracts:
//
//   jobId:uint32,
//   factoryAddr:address,
//   clientAddr:address,
//   hasProvider:bool, [providerAddr:address if hasProvider],
//   state:uint8,
//   ref -> details cell

fun loadMainData(): (int, address, address, address?, int, cell) {
    var cs = contract.getData().beginParse();
    val jobId = cs.loadUint(32);
    val factory = cs.loadAddress();
    val client = cs.loadAddress();
    val hasProvider = cs.loadBool();
    var provider: address? = null;
    if (hasProvider) {
        provider = cs.loadAddress();
    }
    val state = cs.loadUint(8);
    val detailsCell = cs.loadRef();
    return (jobId, factory, client, provider, state, detailsCell);
}

fun saveData(jobId: int, factory: address, client: address, provider: address?, state: int, detailsCell: cell) {
    var b = beginCell()
        .storeUint(jobId, 32)
        .storeAddress(factory)
        .storeAddress(client);
    if (provider != null) {
        b.storeBool(true).storeAddress(provider!);
    } else {
        b.storeBool(false);
    }
    b.storeUint(state, 8)
     .storeRef(detailsCell);
    contract.setData(b.endCell());
}

// Predicate reused by the three settlement opcodes: assert the contract
// is currently in one of the SETTLING_* parking-orbit states.
fun isSettlingState(state: int): bool {
    return state == STATE_SETTLING_COMPLETED
        || state == STATE_SETTLING_DISPUTED
        || state == STATE_SETTLING_CANCELLED;
}

// Translate a SETTLING_* state into its final terminal state, used by
// CommitSettlement once a payout has drained the contract.
fun settlingToTerminal(state: int): int {
    if (state == STATE_SETTLING_COMPLETED) {
        return STATE_COMPLETED;
    }
    if (state == STATE_SETTLING_DISPUTED) {
        return STATE_DISPUTED;
    }
    return STATE_CANCELLED;
}
