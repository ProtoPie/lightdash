terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.28.0"
    }
  }
  backend "s3" {
    bucket       = "xid-prod-terraform"
    key          = "lightdash-prod"
    region       = "us-west-2"
    profile      = "xid-prod"
    use_lockfile = true
  }
}

provider "aws" {
  profile = "xid-prod"
  region  = "us-west-2"
}

locals {
  env_name = "prod"

  common_tags = tomap({
    "maintainer" = "mamur@protopie.io",
    "terraform"  = "https://github.com/ProtoPie/lightdash"
  })

  envs = { for tuple in regexall("(.*?)=(.*)", file(".env")) : tuple[0] => sensitive(tuple[1]) }
}

# Resolve the AWS-managed SSM KMS key by alias so the IAM policy below uses the
# real key ARN. kms:Decrypt API calls evaluate against key ARN, not alias ARN.
data "aws_kms_key" "ssm" {
  key_id = "alias/aws/ssm"
}

data "aws_region" "current" {}

data "aws_availability_zones" "current" {}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "all" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  tags = {
    Tier = "Private"
  }
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  tags = {
    Tier = "Public"
  }
}

# Data source to fetch details for public subnets
data "aws_subnet" "public_subnets" {
  for_each = toset(data.aws_subnets.public.ids)
  id       = each.key
}

# Data source to fetch details for private subnets
data "aws_subnet" "private_subnets" {
  for_each = toset(data.aws_subnets.private.ids)
  id       = each.key
}


resource "aws_db_subnet_group" "default_db_subnet_group" {
  name        = "default-db-subnet-group"
  description = "DB subnet group in the default VPC"
  subnet_ids  = concat(data.aws_subnets.private.ids, data.aws_subnets.public.ids)
}

resource "aws_iam_role" "ecs_task_execution" {

  name = "lightdash_ecs_task_execution_role"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "",
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
}

########################
resource "aws_iam_policy" "cloudwatch_logs_access" {
  name_prefix = "cloudwatch_logs_access_"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "logs:GetLogEvents"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.id
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_cloud_watch_access" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.cloudwatch_logs_access.arn
}

# ad s3 access policy to the ecs task execution role
resource "aws_iam_policy" "s3_access" {
  name_prefix = "s3_access_"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = "*"
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "ecs_task_execution_s3_access" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.s3_access.arn
}

# SSM Parameter Store access for ECS task secrets injection.
# Scoped to /lightdash/<env>/* parameters and the default aws/ssm KMS key.
resource "aws_iam_policy" "ssm_secrets_access" {
  name_prefix = "ssm_secrets_access_${local.env_name}_"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/lightdash/${local.env_name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = data.aws_kms_key.ssm.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_ssm_secrets" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.ssm_secrets_access.arn
}