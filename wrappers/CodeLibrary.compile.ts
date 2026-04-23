import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/code_library.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
