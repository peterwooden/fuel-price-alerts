import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as lambda from '@aws-cdk/aws-lambda';
import * as apigateway from '@aws-cdk/aws-apigateway';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as rds from '@aws-cdk/aws-rds';
import { Duration } from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as cognito from '@aws-cdk/aws-cognito';
import * as iam from '@aws-cdk/aws-iam';
import { SPADeploy } from 'cdk-spa-deploy';
require('dotenv').config();

const SES_REGION = 'ap-southeast-2';
const SES_EMAIL_FROM = 'peterwooden.com';

export class FuelPriceAlertsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'FuelPriceVPC', {
      maxAzs: 2
    });

    const postgres = new rds.ServerlessCluster(this, 'Postgres', {
      engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
      parameterGroup: rds.ParameterGroup.fromParameterGroupName(this, 'ParameterGroup', 'default.aurora-postgresql10'),
      vpc,
      defaultDatabaseName: 'postgres',
      scaling: {
        autoPause: Duration.minutes(5),
        minCapacity: rds.AuroraCapacityUnit.ACU_2,
        maxCapacity: rds.AuroraCapacityUnit.ACU_4
      }
    });

    const postgresDataApiParams = {
      CLUSTER_ARN: postgres.clusterArn,
      SECRET_ARN: postgres.secret?.secretArn || '',
      DB_NAME: 'postgres',
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1'
    };

    const fetchPrices = new lambda.Function(this, 'FetchPrices', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset('src'),
      handler: 'fetch-prices.handler',
      timeout: Duration.minutes(10),
      environment: {
        ...postgresDataApiParams,
        API_NSW_APIKEY: process.env.API_NSW_APIKEY || '',
        API_NSW_BASICAUTH: process.env.API_NSW_BASICAUTH || ''
      }
    });

    postgres.grantDataApiAccess(fetchPrices);


    fetchPrices.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ses:SendEmail',
          'ses:SendRawEmail',
          'ses:SendTemplatedEmail',
        ],
        resources: [
          `arn:aws:ses:${SES_REGION}:${
            cdk.Stack.of(this).account
          }:identity/${SES_EMAIL_FROM}`,
        ],
      }),
    )

    const timerRule = new events.Rule(this, 'TimerRule', {
      schedule: events.Schedule.rate(Duration.hours(2))
    });

    timerRule.addTarget(new targets.LambdaFunction(fetchPrices));


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
        emailBody: 'Hello {username}, you have been invited to join Fuel Price Alerts! Your temporary password is {####}',
        smsMessage: 'Hello {username}, you have been invited to join Fuel Price Alerts! Your temporary password for Fuel Price Alerts is {####}'
      },
      signInAliases: {
        email: true
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        }
      }
    });
    const client = userPool.addClient('user-app-client', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });
    const clientId = client.userPoolClientId;

    new SPADeploy(this, 'frontend').createSiteFromHostedZone({
      indexDoc: 'index.html',
      errorDoc: 'index.html',
      websiteFolder: '../frontend/build',
      zoneName: 'peterwooden.com',
      subdomain: 'fuelpricealerts'
    });

    const api = new apigateway.RestApi(this, "rest-api", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS // this is also the default
      }
    });

    const alertSubscriptionsHandler = new lambda.Function(this, 'Alert subscriptions handler', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset('src'),
      handler: 'alert-subscriptions.handler',
      timeout: Duration.minutes(2),
      environment: {
        ...postgresDataApiParams,
        COGNITO_POOL_ID: userPool.userPoolId
      }
    });

    postgres.grantDataApiAccess(alertSubscriptionsHandler);

    const alertSubscriptions = api.root.addResource('alert-subscriptions');

    alertSubscriptions.addMethod('POST', new apigateway.LambdaIntegration(alertSubscriptionsHandler));
    alertSubscriptions.addMethod('GET', new apigateway.LambdaIntegration(alertSubscriptionsHandler));

    /*

    const login = new lambda.Function(this, 'FetchPrices', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset('lambda/fromPrices'),
      handler: 'index.handler'
    });

    const deleteAccount = new lambda.Function(this, 'FetchPrices', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset('lambda/fromPrices'),
      handler: 'index.handler'
    });

    const setupStations = new lambda.Function(this, 'FetchPrices', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset('lambda/fromPrices'),
      handler: 'index.handler'
    });*/
  }
}
