// Sourced from https://github.com/awslabs/aws-support-tools/blob/e135e30aad0d017ec54c5dde0c8358d14f29182b/Cognito/decode-verify-jwt/decode-verify-jwt.ts
import { promisify } from 'util';
import * as Axios from 'axios';
import * as jsonwebtoken from 'jsonwebtoken';
const jwkToPem = require('jwk-to-pem');

export interface ClaimVerifyRequest {
    readonly token: string;
}

export type ClaimVerifyResult = {
    readonly claims: Claim;
    readonly isValid: true;
} | {
  readonly isValid: false;
  readonly error: any;
}

interface TokenHeader {
    kid: string;
    alg: string;
}
interface PublicKey {
    alg: string;
    e: string;
    kid: string;
    kty: string;
    n: string;
    use: string;
}
interface PublicKeyMeta {
    instance: PublicKey;
    pem: string;
}

interface PublicKeys {
    keys: PublicKey[];
}

interface MapOfKidToPublicKey {
    [key: string]: PublicKeyMeta;
}

interface Claim {
    token_use: string;
    auth_time: number;
    iss: string;
    exp: number;
    username: string;
    client_id: string;
    sub: string;
    email: string;
}

const cognitoPoolId = process.env.COGNITO_POOL_ID || '';
if (!cognitoPoolId) {
    throw new Error('env var required for cognito pool');
}
const awsRegion = process.env.AWS_REGION;
if (!awsRegion) {
    throw new Error('AWS region for cognito pool');
}
const cognitoIssuer = `https://cognito-idp.${awsRegion}.amazonaws.com/${cognitoPoolId}`;

let cacheKeys: MapOfKidToPublicKey | undefined;
const getPublicKeys = async (): Promise<MapOfKidToPublicKey> => {
    if (!cacheKeys) {
        const url = `${cognitoIssuer}/.well-known/jwks.json`;
        const publicKeys = await Axios.default.get<PublicKeys>(url);
        cacheKeys = publicKeys.data.keys.reduce((agg, current) => {
            const pem = jwkToPem(current);
            agg[current.kid] = { instance: current, pem };
            return agg;
        }, {} as MapOfKidToPublicKey);
        return cacheKeys;
    } else {
        return cacheKeys;
    }
};

const verifyPromised = promisify(jsonwebtoken.verify.bind(jsonwebtoken));

const handler = async (
    request: ClaimVerifyRequest
): Promise<ClaimVerifyResult> => {
    let result: ClaimVerifyResult;
    try {
        console.log(`user claim verify invoked for ${JSON.stringify(request)}`);
        const token = request.token;
        const tokenSections = (token || '').split('.');
        if (tokenSections.length < 2) {
            throw new Error('requested token is invalid');
        }
        const headerJSON = Buffer.from(tokenSections[0], 'base64').toString(
            'utf8'
        );
        const header = JSON.parse(headerJSON) as TokenHeader;
        const keys = await getPublicKeys();
        const key = keys[header.kid];
        if (key === undefined) {
            throw new Error('claim made for unknown kid');
        }
        const claim = (await verifyPromised(token, key.pem)) as Claim;
        const currentSeconds = Math.floor(new Date().valueOf() / 1000);
        if (currentSeconds > claim.exp || currentSeconds < claim.auth_time) {
            throw new Error('claim is expired or invalid');
        }
        if (claim.iss !== cognitoIssuer) {
            throw new Error('claim issuer is invalid');
        }
        console.log(`claim confirmed for ${claim.username}`);
        result = {
            claims: claim,
            isValid: true,
        };
    } catch (error) {
        console.log(`Invalid token: ${error}`);
        result = { error, isValid: false };
    }
    return result;
};

export default handler;
