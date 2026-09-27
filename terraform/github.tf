# GitHub Actions deploys from main by assuming this role via OIDC: no long-lived keys.
# It runs `terraform apply`, so it can manage this project's resources and nothing else.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.name}-github-deploy"
  max_session_duration = 3600
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "terraform-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid     = "TerraformState"
    actions = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      "arn:aws:s3:::fuel-price-alerts-tfstate-${local.account_id}",
      "arn:aws:s3:::fuel-price-alerts-tfstate-${local.account_id}/*",
    ]
  }
  statement {
    sid     = "ProjectBuckets"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.data.arn, aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*",
    ]
  }
  statement {
    sid       = "Lambdas"
    actions   = ["lambda:*"]
    resources = ["arn:aws:lambda:*:${local.account_id}:function:${local.name}-*"]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:*"]
    resources = ["arn:aws:logs:*:${local.account_id}:log-group:/aws/lambda/${local.name}-*"]
  }
  statement {
    sid       = "Schedule"
    actions   = ["events:*"]
    resources = ["arn:aws:events:*:${local.account_id}:rule/${local.name}-*"]
  }
  statement {
    sid     = "ProjectRoles"
    actions = ["iam:*"]
    resources = [
      "arn:aws:iam::${local.account_id}:role/${local.name}-*",
      aws_iam_openid_connect_provider.github.arn,
    ]
  }
  statement {
    sid       = "Cognito"
    actions   = ["cognito-idp:Describe*", "cognito-idp:Get*", "cognito-idp:List*", "cognito-idp:Update*"]
    resources = [aws_cognito_user_pool.users.arn]
  }
  statement {
    sid       = "Site"
    actions   = ["cloudfront:*", "acm:*"]
    resources = ["*"]
  }
  statement {
    sid       = "Dns"
    actions   = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets", "route53:GetChange", "route53:ListTagsForResource"]
    resources = ["arn:aws:route53:::hostedzone/${local.zone_id}", "arn:aws:route53:::change/*"]
  }
  statement {
    sid       = "ReadOnlyLookups"
    actions   = ["sts:GetCallerIdentity", "iam:ListOpenIDConnectProviders", "ssm:DescribeParameters", "s3:ListAllMyBuckets"]
    resources = ["*"]
  }
}
