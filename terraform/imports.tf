# One-time adoption of resources first created by CDK/CloudFormation (September 2026).
# Safe to delete this file once the import has been applied.

import {
  to = aws_cognito_user_pool.users
  id = "ap-southeast-2_0FfD1T3W3"
}
import {
  to = aws_cognito_user_pool_client.web
  id = "ap-southeast-2_0FfD1T3W3/2bu6oemq362ll86rqifn3piimd"
}

import {
  to = aws_s3_bucket.data
  id = "fuelpricealertsstack-data666c94c7-q9eckrplxqim"
}
import {
  to = aws_s3_bucket_versioning.data
  id = "fuelpricealertsstack-data666c94c7-q9eckrplxqim"
}
import {
  to = aws_s3_bucket_lifecycle_configuration.data
  id = "fuelpricealertsstack-data666c94c7-q9eckrplxqim"
}
import {
  to = aws_s3_bucket_server_side_encryption_configuration.data
  id = "fuelpricealertsstack-data666c94c7-q9eckrplxqim"
}
import {
  to = aws_s3_bucket_public_access_block.data
  id = "fuelpricealertsstack-data666c94c7-q9eckrplxqim"
}
import {
  to = aws_s3_bucket_policy.data
  id = "fuelpricealertsstack-data666c94c7-q9eckrplxqim"
}

import {
  to = aws_iam_openid_connect_provider.github
  id = "arn:aws:iam::032326623602:oidc-provider/token.actions.githubusercontent.com"
}
import {
  to = aws_iam_role.github_deploy
  id = "fuel-price-alerts-github-deploy"
}

import {
  to = aws_acm_certificate.site
  id = "arn:aws:acm:us-east-1:032326623602:certificate/41ef7224-527a-49e3-be1e-b62f580a8781"
}
import {
  to = aws_s3_bucket.site
  id = "fuelpricealertsweb-sitee53d7754-qbykyyoe6di5"
}
import {
  to = aws_s3_bucket_server_side_encryption_configuration.site
  id = "fuelpricealertsweb-sitee53d7754-qbykyyoe6di5"
}
import {
  to = aws_s3_bucket_public_access_block.site
  id = "fuelpricealertsweb-sitee53d7754-qbykyyoe6di5"
}
import {
  to = aws_s3_bucket_policy.site
  id = "fuelpricealertsweb-sitee53d7754-qbykyyoe6di5"
}
import {
  to = aws_cloudfront_origin_access_control.site
  id = "E1IND20BYEDNB1"
}
import {
  to = aws_cloudfront_distribution.site
  id = "E1N6GBUGXS1JTD"
}
import {
  to = aws_route53_record.site["A"]
  id = "Z05956822F62HQUM60NM9_fuelpricealerts.peterwooden.com_A"
}
import {
  to = aws_route53_record.site["AAAA"]
  id = "Z05956822F62HQUM60NM9_fuelpricealerts.peterwooden.com_AAAA"
}
