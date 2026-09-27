# Migration runbook: Aurora to S3

Status as of 2026-09-27. Steps 0–2 are done. **Step 3 onwards is waiting for approval**,
because it replaces production.

Region is ap-southeast-2 unless stated. Run from `infrastructure/` with admin credentials.

```bash
export AWS_REGION=ap-southeast-2 AWS_DEFAULT_REGION=ap-southeast-2 CDK_DEFAULT_ACCOUNT=032326623602
CLUSTER=arn:aws:rds:ap-southeast-2:032326623602:cluster:fuelpricealertsstack-rdse0e96d00-1892za0nx5xpm
SECRET=arn:aws:secretsmanager:ap-southeast-2:032326623602:secret:RDSSecret3683CA93-q7HoSNElx2kr-vkglFE
```

## Done

0. **Config in SSM.** Created `/fuel-price-alerts/nsw-api-key`, `/fuel-price-alerts/nsw-api-basic-auth`
   (SecureString) and `/fuel-price-alerts/error-email` from the old Lambda's environment.
1. **Aurora protected.** On the old stack, the cluster, its secret, subnet group, security group
   and VPC are now `DeletionPolicy: Retain`, so the redeploy detaches them instead of deleting
   them. This was a metadata-only change; the app kept running.
2. **CDK v2 bootstrapped** in ap-southeast-2 and us-east-1.
3. **Trial export and parity.** A full export verified against Postgres checksums, and the new
   engine proved identical to the SQL at 11 timestamps (see `cost-reduction.md`).

## To do

### 3. Deploy (the site is down ~10–20 min)

```bash
cd .. && ./build-and-deploy.sh && cd infrastructure
```

This updates `FuelPriceAlertsStack` in place. It removes the old Lambdas, API Gateway,
CloudFront distribution and bucket deployment, detaches Aurora, and creates the data bucket,
the two Lambdas, the Function URL and the schedule. It then creates `FuelPriceAlertsWeb`
(us-east-1) and uploads the frontend. The Cognito pool and client are untouched (checked
with `cdk diff`). Aurora stops receiving writes here, because the old ingest Lambda is gone.

The new schedule first fires 2 hours after deploy. Finish step 4 before then, or the run
fails safely ("state.json.gz is missing") and sends one error email.

### 4. Final export, then load S3

```bash
BUCKET=$(node -p "require('./cdk-outputs.json').FuelPriceAlertsStack.DataBucketName")
INGEST=$(node -p "require('./cdk-outputs.json').FuelPriceAlertsStack.IngestFunctionName")
npx tsx scripts/export-aurora.ts --cluster $CLUSTER --secret $SECRET --out ./export   # aborts on any checksum mismatch
npx tsx scripts/build-state.ts --dir ./export
aws s3 sync ./export s3://$BUCKET/ --exclude '*.gz'
aws s3 sync ./export s3://$BUCKET/ --exclude '*' --include '*.gz' --content-encoding gzip
```

### 5. Verify

```bash
aws lambda invoke --function-name $INGEST /dev/stdout   # expect newPrices > 0, seriesInWindow ≈ 14,350
aws s3 ls s3://$BUCKET/history/prices/ | tail -3
curl -sI https://fuelpricealerts.peterwooden.com | head -1
```

Then sign in at https://fuelpricealerts.peterwooden.com. Your 5 U91 stations should be
pre-selected. Press Save.

Optionally, re-run `scripts/parity-check.ts --dir ./export --at <now>` while Aurora still exists.

### 6. Retire Aurora (only after step 5 passes)

```bash
ID=fuelpricealertsstack-rdse0e96d00-1892za0nx5xpm
aws rds create-db-cluster-snapshot --db-cluster-identifier $ID --db-cluster-snapshot-identifier fuel-price-alerts-final-2026-09
aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier fuel-price-alerts-final-2026-09
aws rds delete-db-instance --db-instance-identifier $ID-instance-1
aws rds wait db-instance-deleted --db-instance-identifier $ID-instance-1
aws rds delete-db-cluster --db-cluster-identifier $ID --skip-final-snapshot   # the manual snapshot above is the final copy
# once the cluster is gone:
aws rds delete-db-subnet-group --db-subnet-group-name fuelpricealertsstack-rdssubnets873fc54a-18josnsasvqk2
aws ec2 delete-security-group --group-id sg-0d100b81e8588af0f
aws ec2 disassociate-route-table --association-id rtbassoc-01c8eea7a69c5a946
aws ec2 disassociate-route-table --association-id rtbassoc-0f0b61a1b312862bb
aws ec2 delete-route-table --route-table-id rtb-06cc29d4db85815d5
aws ec2 delete-route-table --route-table-id rtb-046dc59b4d6a05bff
aws ec2 delete-subnet --subnet-id subnet-0ef49aa1aae1b1154
aws ec2 delete-subnet --subnet-id subnet-06e599f3a2c1bf139
aws ec2 detach-internet-gateway --internet-gateway-id igw-0215cb71b43e30cc9 --vpc-id vpc-0a43ab4deb2d783f9
aws ec2 delete-internet-gateway --internet-gateway-id igw-0215cb71b43e30cc9
aws ec2 delete-vpc --vpc-id vpc-0a43ab4deb2d783f9
for s in RDSSecret3683CA93-q7HoSNElx2kr rds-db-credentials/cluster-2PUHO2RBJ7DKQV57MHK5IRR5EM/postgres rds-db-credentials/cluster-KN2FWSHBBHZHVHPVWBOLUM2RQQ/postgres; do
  aws secretsmanager delete-secret --secret-id $s --recovery-window-in-days 7; done
```

Superseded Aurora snapshots (the S3 export and the final snapshot above replace them):
`fuel-price-alerta-2021-06-03`, `fuelpricealertsstack-postgres9dc8bb04-lphsuv4rdz5s-final-snapshot`,
`preupgrade-…-10-21-to-11-16-2023-05-06-19-24`, `preupgrade-…-11-21-to-13-12-2024-06-29-19-24`,
`pre-modify-engine-mode-…-2026-01-10-19-27` (`aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier <id>`).

Fuel leftovers:
- the old site bucket `fuelpricealertsstack-frontendwebsitebucketfd9d436-1hck9c5p0xze0` and four empty siblings
- the empty Cognito pool `ap-southeast-2_dpNmRJi0p`
- the legacy CDK staging bucket `cdktoolkit-stagingbucket-39qz62pbh7ti`
- the dangling rule `fetch-fuel-price-trigger` (its target Lambda no longer exists)
- log groups under `/aws/lambda/FuelPriceAlertsStack-*`, `/aws/lambda/fetch-fuel-prices` and `/aws/rds/cluster/fuel*`

### 7. Rest of the account (owner's decision, see `cost-reduction.md` §5)

```bash
# Stopped since 2021: keep an AMI of each, then terminate, then release the idle Elastic IP.
for i in i-018ba8c658fe1781b i-04597dad2aa174c2e i-083bbf16966759fd8 i-0cefe8c8c3c49b532; do
  aws ec2 create-image --instance-id $i --name "backup-$i-2026-09" --no-reboot; done
# ...wait for the AMIs to become available, then:
aws ec2 terminate-instances --instance-ids i-018ba8c658fe1781b i-04597dad2aa174c2e i-083bbf16966759fd8 i-0cefe8c8c3c49b532
aws ec2 release-address --allocation-id eipalloc-0e52fd453a5ae4252
# OpenVPN (Terraform-managed, us-east-1): prefer `terraform destroy` from wherever its state lives; otherwise
aws ec2 terminate-instances --region us-east-1 --instance-ids i-086c4387e31b1692a
# Stale keys (reversible):
aws iam update-access-key --user-name amplify-dell-laptop --access-key-id <id> --status Inactive
aws iam update-access-key --user-name fuel-price-alerts-cli --access-key-id <id> --status Inactive
```

## Rollback

Until step 6, Aurora and all its data still exist, untouched. Also:
- If step 3 fails, CloudFormation rolls the stack back to the old version.
- If the new system misbehaves after step 3, the data is safe in Aurora and S3 and the fix is
  forward. The old frontend and API were CDK v1 on Node 14, so they can't be redeployed as they were.
