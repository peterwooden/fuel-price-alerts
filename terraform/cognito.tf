# The user pool holds real accounts and passwords, which can't be exported or recreated.

resource "aws_cognito_user_pool" "users" {
  name                     = "UserPool6BA7E5F2-JFyYwY8s1815" # name from the original 2021 deploy
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = false
    invite_message_template {
      email_subject = "Invite to join Fuel Price Alerts!"
      email_message = "Hello {username}, you have been invited to join Fuel Price Alerts! Your temporary password is {####}"
      sms_message   = "Hello {username}, you have been invited to join Fuel Price Alerts! Your temporary password for Fuel Price Alerts is {####}"
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Verify your email for Fuel Price Alerts"
    email_message        = "Thanks for signing up to Fuel Price Alerts! Your verification code is {####}"
    sms_message          = "Thanks for signing up to Fuel Price Alerts! Your verification code is {####}"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_phone_number"
      priority = 1
    }
    recovery_mechanism {
      name     = "verified_email"
      priority = 2
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }

  lifecycle {
    prevent_destroy = true
    # Schema can't be changed after creation; never let a diff here force a replacement.
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                          = "UserPooluserappclient0A9D9210-y2THPaRZxVO6"
  user_pool_id                  = aws_cognito_user_pool.users.id
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  refresh_token_validity        = 30
  auth_session_validity         = 3

  # OAuth settings as originally created (CDK defaults). The app signs in with SRP and never
  # uses the hosted UI, but they're kept as-is so adopting the client changes nothing.
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"]
  allowed_oauth_scopes                 = ["aws.cognito.signin.user.admin", "email", "openid", "phone", "profile"]
  callback_urls                        = ["https://example.com"]
  supported_identity_providers         = ["COGNITO"]

  lifecycle {
    prevent_destroy = true
  }
}
