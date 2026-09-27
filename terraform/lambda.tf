# Two Lambdas built by `npm run build` in backend/ (esbuild -> backend/dist/<name>/index.js).

data "archive_file" "ingest" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/ingest"
  output_path = "${path.module}/.build/ingest.zip"
}

data "archive_file" "subscriptions" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/subscriptions"
  output_path = "${path.module}/.build/subscriptions.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- Ingest: every 2 hours, fetch NSW prices, update S3, send alerts ----

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${local.name}-ingest"
  retention_in_days = 90
}

resource "aws_iam_role" "ingest" {
  name               = "${local.name}-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "ingest" {
  role   = aws_iam_role.ingest.id
  policy = data.aws_iam_policy_document.ingest.json
}

data "aws_iam_policy_document" "ingest" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ingest.arn}:*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/*"]
  }
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.config_prefix}*"]
  }
  statement {
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["arn:aws:ses:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:identity/${local.ses_identity}"]
  }
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${local.name}-ingest"
  role             = aws_iam_role.ingest.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  memory_size      = 512
  timeout          = 120
  # One run at a time; state writes are also conditional as a second guard.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      NODE_OPTIONS  = "--enable-source-maps"
      DATA_BUCKET   = aws_s3_bucket.data.id
      CONFIG_PREFIX = local.config_prefix
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.ingest.name
  }
}

resource "aws_lambda_function_event_invoke_config" "ingest" {
  function_name          = aws_lambda_function.ingest.function_name
  maximum_retry_attempts = 0 # the next scheduled run catches up anyway
}

resource "aws_cloudwatch_event_rule" "ingest" {
  name                = "${local.name}-ingest"
  schedule_expression = "rate(2 hours)"
}

resource "aws_cloudwatch_event_target" "ingest" {
  rule = aws_cloudwatch_event_rule.ingest.name
  arn  = aws_lambda_function.ingest.arn
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "ingest_schedule" {
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ingest.arn
}

# ---- Subscriptions API: GET/POST a user's stations via a Function URL ----

resource "aws_cloudwatch_log_group" "subscriptions" {
  name              = "/aws/lambda/${local.name}-subscriptions-api"
  retention_in_days = 90
}

resource "aws_iam_role" "subscriptions" {
  name               = "${local.name}-subscriptions-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "subscriptions" {
  role   = aws_iam_role.subscriptions.id
  policy = data.aws_iam_policy_document.subscriptions.json
}

data "aws_iam_policy_document" "subscriptions" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.subscriptions.arn}:*"]
  }
  # ListBucket makes a missing object a 404 (new user) rather than 403.
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["subscriptions/*"]
    }
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/subscriptions/*"]
  }
}

resource "aws_lambda_function" "subscriptions" {
  function_name    = "${local.name}-subscriptions-api"
  role             = aws_iam_role.subscriptions.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.subscriptions.output_path
  source_code_hash = data.archive_file.subscriptions.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      NODE_OPTIONS        = "--enable-source-maps"
      DATA_BUCKET         = aws_s3_bucket.data.id
      USER_POOL_ID        = aws_cognito_user_pool.users.id
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.web.id
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.subscriptions.name
  }
}

resource "aws_lambda_function_url" "subscriptions" {
  function_name      = aws_lambda_function.subscriptions.function_name
  authorization_type = "NONE" # the handler verifies the Cognito ID token itself

  cors {
    allow_origins = [local.site_origin, "http://localhost:3000"]
    allow_methods = ["GET", "POST"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 86400
  }
}

# A public Function URL needs both permissions.
resource "aws_lambda_permission" "subscriptions_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.subscriptions.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "subscriptions_invoke" {
  statement_id             = "AllowInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.subscriptions.function_name
  principal                = "*"
  invoked_via_function_url = true
}
