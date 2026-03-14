import { Address } from '@ton/core';

export const config = {
    factoryAddress: Address.parse(process.env.FACTORY_ADDRESS || 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX'),
    jettonFactoryAddress: Address.parse(process.env.JETTON_FACTORY_ADDRESS || 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj'),
    walletMnemonic: process.env.WALLET_MNEMONIC?.split(' ') ?? [],
    network: (process.env.NETWORK ?? 'mainnet') as 'testnet' | 'mainnet',
    endpoint: process.env.NETWORK === 'testnet'
        ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
        : 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TONCENTER_API_KEY ?? '',
    pinataJwt: process.env.PINATA_JWT ?? '',
};
