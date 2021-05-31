#!/bin/bash
echo Building infrastructure...

cd infrastructure
npm run build

echo Building frontend...

cd ../frontend
npm run build

echo Deploying infrastructure...

cd ../infrastructure
cdk bootstrap
cdk deploy -v --require-approval never