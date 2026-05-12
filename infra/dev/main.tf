terraform {
  backend "s3" {
    bucket       = "xid-prod-terraform"
    key          = "lightdash-dev"
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
  common_tags = tomap({
    "maintainer" = "mamur@protopie.io",
    "terraform"  = "https://github.com/ProtoPie/lightdash"
  })

  envs = { for tuple in regexall("(.*?)=(.*)", file(".env")) : tuple[0] => sensitive(tuple[1]) }
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
  name        = "default-db-subnet-group-dev"
  description = "DB subnet group in the default VPC"
  subnet_ids  = concat(data.aws_subnets.private.ids, data.aws_subnets.public.ids)
}

resource "aws_iam_role" "ecs_task_execution" {

  name = "lightdash_ecs_task_execution_role_dev"

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
  name_prefix = "cloudwatch_logs_access_dev_"

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

# S3 access policy for Lightdash
resource "aws_iam_policy" "s3_access" {
  name_prefix = "s3_access_dev_"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.lightdash_dev.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = aws_s3_bucket.lightdash_dev.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_s3_access" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.s3_access.arn
}