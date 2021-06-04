#!/bin/bash
echo Building lambdas...
cd infrastructure/src
npm ci

echo Building infrastructure...

cd infrastructure
npm ci
npm run build

echo Building frontend...

cd ../frontend
npm ci
npm run build

echo Deploying infrastructure...

cd ../infrastructure
cdk bootstrap
cdk synth
cdk deploy -v --require-approval never