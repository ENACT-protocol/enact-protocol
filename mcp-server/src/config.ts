import { Address } from '@ton/core';

export const config = {
    factoryAddress: Address.parse(process.env.FACTORY_ADDRESS || 'EQBWzGqJmn5BpUPyWmLsEM5uBzTOUct-n0-uj-5-uAA89Hk5'),
    jettonFactoryAddress: Address.parse(process.env.JETTON_FACTORY_ADDRESS || 'EQB7oc6nSBcazrygJ9IoBE4FAQuQls0mQp7MbDO4a-RKKt4s'),
    walletMnemonic: process.env.WALLET_MNEMONIC?.split(' ') ?? [],
    network: (process.env.NETWORK ?? 'mainnet') as 'testnet' | 'mainnet',
    endpoint: process.env.NETWORK === 'testnet'
        ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
        : 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TONCENTER_API_KEY ?? '',
    pinataJwt: process.env.PINATA_JWT ?? '',
};
