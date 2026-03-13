import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/jetton_job_factory.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
