import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/job.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
