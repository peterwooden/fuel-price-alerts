import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as lambda from '@aws-cdk/aws-lambda';
import * as apigw from '@aws-cdk/aws-apigateway';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as rds from '@aws-cdk/aws-rds';
import { Duration } from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as cognito from '@aws-cdk/aws-cognito';
import { SPADeploy } from 'cdk-spa-deploy';
require('dotenv').config();

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
      environment: {
        ...postgresDataApiParams,
        API_NSW_APIKEY: process.env.API_NSW_APIKEY || '',
        API_NSW_BASICAUTH: process.env.API_NSW_BASICAUTH || ''
      }
    });

    postgres.grantDataApiAccess(fetchPrices);

    const timerRule = new events.Rule(this, 'TimerRule', {
      schedule: events.Schedule.rate(Duration.hours(2))
    });

    timerRule.addTarget(new targets.LambdaFunction(fetchPrices));

    const register = new lambda.Function(this, 'Register', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset('src'),
      handler: 'register.handler',
      environment: postgresDataApiParams
    });

    postgres.grantDataApiAccess(register);

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
