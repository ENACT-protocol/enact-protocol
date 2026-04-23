import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/job_factory_lib.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
