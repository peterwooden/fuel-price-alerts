// Runtime configuration lives in SSM Parameter Store (standard tier: free), so no secret
// ever appears in a CloudFormation template or Lambda environment variable.

import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface Config {
    nswApiKey: string;
    nswApiBasicAuth: string;
    errorEmail?: string;
}

let cached: Promise<Config> | undefined;

export function loadConfig(prefix = process.env.CONFIG_PREFIX ?? '/fuel-price-alerts/', ssm = new SSMClient({})) {
    cached ??= (async () => {
        const names = ['nsw-api-key', 'nsw-api-basic-auth', 'error-email'].map((name) => prefix + name);
        const { Parameters = [] } = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
        const get = (name: string) => Parameters.find((p) => p.Name === prefix + name)?.Value;
        const nswApiKey = get('nsw-api-key');
        const nswApiBasicAuth = get('nsw-api-basic-auth');
        if (!nswApiKey || !nswApiBasicAuth) throw new Error(`Missing NSW API credentials under ${prefix}`);
        return { nswApiKey, nswApiBasicAuth, errorEmail: get('error-email') };
    })().catch((e) => {
        cached = undefined;
        throw e;
    });
    return cached;
}
