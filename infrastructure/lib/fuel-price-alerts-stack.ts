import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

const CONFIG_PREFIX = '/fuel-price-alerts/';
const SES_IDENTITY = 'peterwooden.com';
export const GITHUB_DEPLOY_ROLE_NAME = 'fuel-price-alerts-github-deploy';

export interface FuelPriceAlertsStackProps extends StackProps {
    siteOrigin: string;
    /** owner/name of the GitHub repo allowed to deploy from main */
    githubRepo: string;
}

/**
 * Backend: Cognito, one S3 bucket as the database, and two Lambdas.
 * No VPC, no database server, nothing billed by the hour.
 */
export class FuelPriceAlertsStack extends Stack {
    constructor(scope: Construct, id: string, props: FuelPriceAlertsStackProps) {
        super(scope, id, props);

        // Construct IDs and props match the original CDK v1 stack so CloudFormation keeps the
        // existing pool (and its users) and client in place.
        const userPool = new cognito.UserPool(this, 'UserPool', {
            selfSignUpEnabled: true,
            userVerification: {
                emailSubject: 'Verify your email for Fuel Price Alerts',
                emailBody: 'Thanks for signing up to Fuel Price Alerts! Your verification code is {####}',
                emailStyle: cognito.VerificationEmailStyle.CODE,
                smsMessage: 'Thanks for signing up to Fuel Price Alerts! Your verification code is {####}',
            },
            userInvitation: {
                emailSubject: 'Invite to join Fuel Price Alerts!',
                emailBody:
                    'Hello {username}, you have been invited to join Fuel Price Alerts! Your temporary password is {####}',
                smsMessage:
                    'Hello {username}, you have been invited to join Fuel Price Alerts! Your temporary password for Fuel Price Alerts is {####}',
            },
            signInAliases: { email: true },
            standardAttributes: { email: { required: true, mutable: true } },
            removalPolicy: RemovalPolicy.RETAIN,
        });
        const client = userPool.addClient('user-app-client', {
            authFlows: { userPassword: true, userSrp: true },
            preventUserExistenceErrors: true,
        });

        const data = new s3.Bucket(this, 'Data', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: true,
            lifecycleRules: [
                { noncurrentVersionExpiration: Duration.days(30) },
                { abortIncompleteMultipartUploadAfter: Duration.days(1) },
            ],
            removalPolicy: RemovalPolicy.RETAIN,
        });

        const fn = (id: string, entry: string, props: Partial<nodejs.NodejsFunctionProps>) =>
            new nodejs.NodejsFunction(this, id, {
                entry: path.join(__dirname, '../src', entry),
                runtime: lambda.Runtime.NODEJS_24_X,
                architecture: lambda.Architecture.ARM_64,
                bundling: { minify: true, sourceMap: true, target: 'node24', externalModules: [] },
                logGroup: new logs.LogGroup(this, `${id}Logs`, {
                    retention: logs.RetentionDays.THREE_MONTHS,
                    removalPolicy: RemovalPolicy.DESTROY,
                }),
                ...props,
                environment: {
                    NODE_OPTIONS: '--enable-source-maps',
                    DATA_BUCKET: data.bucketName,
                    ...props.environment,
                },
            });

        const ingest = fn('Ingest', 'ingest.ts', {
            memorySize: 512,
            timeout: Duration.minutes(2),
            // One run at a time; state writes are also conditional as a second guard.
            reservedConcurrentExecutions: 1,
            retryAttempts: 0,
            environment: { CONFIG_PREFIX },
        });
        data.grantReadWrite(ingest);
        ingest.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ssm:GetParameters'],
                resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: CONFIG_PREFIX.slice(1) + '*' })],
            }),
        );
        ingest.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ses:SendEmail', 'ses:SendRawEmail'],
                resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: SES_IDENTITY })],
            }),
        );
        new events.Rule(this, 'Schedule', {
            schedule: events.Schedule.rate(Duration.hours(2)),
            targets: [new targets.LambdaFunction(ingest, { retryAttempts: 0 })],
        });

        const api = fn('SubscriptionsApi', 'subscriptions.ts', {
            memorySize: 256,
            timeout: Duration.seconds(10),
            environment: {
                USER_POOL_ID: userPool.userPoolId,
                USER_POOL_CLIENT_ID: client.userPoolClientId,
            },
        });
        data.grantReadWrite(api, 'subscriptions/*');
        const apiUrl = api.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.NONE,
            cors: {
                allowedOrigins: [props.siteOrigin, 'http://localhost:3000'],
                allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
                allowedHeaders: ['authorization', 'content-type'],
                maxAge: Duration.days(1),
            },
        });

        // GitHub Actions deploys from main by assuming this role via OIDC: no long-lived keys.
        // It can only hand off to the CDK bootstrap roles and upload the static site.
        const github = new iam.OidcProviderNative(this, 'GitHubOidc', {
            url: 'https://token.actions.githubusercontent.com',
            clientIds: ['sts.amazonaws.com'],
        });
        const deployRole = new iam.Role(this, 'GitHubDeployRole', {
            roleName: GITHUB_DEPLOY_ROLE_NAME,
            assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
                StringEquals: {
                    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                    'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/main`,
                },
            }),
            maxSessionDuration: Duration.hours(1),
        });
        deployRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['sts:AssumeRole'],
                resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
            }),
        );
        deployRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                resources: ['arn:aws:s3:::fuelpricealertsweb-site*', 'arn:aws:s3:::fuelpricealertsweb-site*/*'],
            }),
        );
        deployRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['cloudfront:CreateInvalidation'],
                resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
            }),
        );

        new CfnOutput(this, 'ApiUrl', { value: apiUrl.url });
        new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
        new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
        new CfnOutput(this, 'DataBucketName', { value: data.bucketName });
        new CfnOutput(this, 'IngestFunctionName', { value: ingest.functionName });
    }
}
