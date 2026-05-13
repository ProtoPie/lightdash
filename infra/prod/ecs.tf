
variable "lightdash_cpu" {
  description = "Fargate instance CPU units to provision (1 vCPU = 1024 CPU units)"
  default     = 512
}

variable "lightdash_memory" {
  description = "Fargate instance memory to provision (in MiB)"
  default     = 1024
}

variable "lightdash_oci_tag" {
  description = "container image tag"
  default     = "prod-latest"
}

variable "lightdash_oci_image" {
  description = "container image repository"
  default     = "750128304405.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash"
}

#### resources
resource "aws_ecs_cluster" "lightdash_cluster" {
  name = "lightdash-cluster"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_service" "lightdash_service" {
  name        = "lightdash-service"
  cluster     = aws_ecs_cluster.lightdash_cluster.id
  launch_type = "FARGATE"

  task_definition = aws_ecs_task_definition.lightdash_task_definition.arn
  desired_count   = 1

  propagate_tags          = "SERVICE"
  enable_ecs_managed_tags = true

  network_configuration {
    security_groups  = [aws_security_group.ecs_sg.id]
    subnets          = data.aws_subnets.public.ids
    assign_public_ip = true
  }

  health_check_grace_period_seconds = 120
  load_balancer {
    target_group_arn = aws_lb_target_group.lightdash_target_group.arn
    container_name   = "lightdash"
    container_port   = 8080
  }

  depends_on = [
    aws_lb_listener_rule.lightdash_tg_rule_1
  ]
}

resource "aws_cloudwatch_log_group" "lightdash_ecs_log_group" {
  name = "/ecs/lightdash-log-groups"
}

resource "aws_ecs_task_definition" "lightdash_task_definition" {
  requires_compatibilities = ["FARGATE"]
  family                   = "lightdash"
  cpu                      = var.lightdash_cpu
  memory                   = var.lightdash_memory
  task_role_arn            = aws_iam_role.ecs_task_execution.arn
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  network_mode             = "awsvpc"
  container_definitions = jsonencode([{

    name      = "lightdash"
    image     = "${var.lightdash_oci_image}:${var.lightdash_oci_tag}"
    cpu       = var.lightdash_cpu
    memory    = var.lightdash_memory
    essential = true

    environment = [

      {
        "name"  = "NODE_ENV",
        "value" = local.envs["NODE_ENV"]
      },
      {
        "name" : "MCP_ENABLED",
        "value" : "true"
      },
      {
        "name" : "SECURE_COOKIES",
        "value" : local.envs["SECURE_COOKIES"]
      },
      {
        "name" : "TRUST_PROXY",
        "value" : local.envs["TRUST_PROXY"]
      },
      {
        "name" : "LIGHTDASH_LOG_LEVEL",
        "value" : local.envs["LIGHTDASH_LOG_LEVEL"]
      },
      {
        "name" : "LIGHTDASH_QUERY_MAX_LIMIT",
        "value" : local.envs["LIGHTDASH_QUERY_MAX_LIMIT"]
      },
      {
        "name" : "LIGHTDASH_PIVOT_TABLE_MAX_COLUMN_LIMIT",
        "value" : local.envs["LIGHTDASH_PIVOT_TABLE_MAX_COLUMN_LIMIT"]
      },
      {
        "name" : "ALLOW_MULTIPLE_ORGS",
        "value" : local.envs["ALLOW_MULTIPLE_ORGS"]
      },
      {
        "name" : "SCHEDULER_ENABLED",
        "value" : local.envs["SCHEDULER_ENABLED"]
      },
      {
        "name" : "LIGHTDASH_MAX_PAYLOAD",
        "value" : local.envs["LIGHTDASH_MAX_PAYLOAD"]
      },

      {
        "name" : "PGCONNECTIONURI",
        "value" : "postgresql://${local.envs["PGUSER"]}:${local.envs["PGPASSWORD"]}@${module.lightdash_db.db_instance_endpoint}/${local.envs["PGDATABASE"]}?sslmode=no-verify"
      },

      {
        "name" : "LIGHTDASH_SECRET",
        "value" : local.envs["LIGHTDASH_SECRET"]
      },
      {
        "name" : "SITE_URL",
        "value" : local.envs["SITE_URL"]
      },
      {
        "name" : "EMAIL_SMTP_HOST",
        "value" : local.envs["EMAIL_SMTP_HOST"]
      },
      {
        "name" : "EMAIL_SMTP_PORT",
        "value" : local.envs["EMAIL_SMTP_PORT"]
      },
      {
        "name" : "EMAIL_SMTP_SECURE",
        "value" : local.envs["EMAIL_SMTP_SECURE"]
      },
      {
        "name" : "EMAIL_SMTP_USER",
        "value" : local.envs["EMAIL_SMTP_USER"]
      },
      {
        "name" : "EMAIL_SMTP_PASSWORD",
        "value" : local.envs["EMAIL_SMTP_PASSWORD"]
      },
      {
        "name" : "EMAIL_SMTP_SENDER_EMAIL",
        "value" : local.envs["EMAIL_SMTP_SENDER_EMAIL"]
      },
      {
        "name" : "SLACK_CLIENT_ID",
        "value" : local.envs["SLACK_CLIENT_ID"]
      },
      {
        "name" : "SLACK_CLIENT_SECRET",
        "value" : local.envs["SLACK_CLIENT_SECRET"]
      },
      {
        "name" : "SLACK_SIGNING_SECRET",
        "value" : local.envs["SLACK_SIGNING_SECRET"]
      },
      {
        "name" : "SLACK_STATE_SECRET",
        "value" : local.envs["SLACK_STATE_SECRET"]
      },
      {
        "name" : "AUTH_DISABLE_PASSWORD_AUTHENTICATION",
        "value" : local.envs["AUTH_DISABLE_PASSWORD_AUTHENTICATION"]
      },
      {
        "name" : "AUTH_OKTA_OAUTH_CLIENT_ID",
        "value" : local.envs["AUTH_OKTA_OAUTH_CLIENT_ID"]
      },
      {
        "name" : "AUTH_OKTA_OAUTH_CLIENT_SECRET",
        "value" : local.envs["AUTH_OKTA_OAUTH_CLIENT_SECRET"]
      },
      {
        "name" : "AUTH_OKTA_OAUTH_ISSUER",
        "value" : local.envs["AUTH_OKTA_OAUTH_ISSUER"]
      },
      {
        "name" : "AUTH_OKTA_DOMAIN",
        "value" : local.envs["AUTH_OKTA_DOMAIN"]
      },
      {
        "name" : "S3_ENDPOINT",
        "value" : local.envs["S3_ENDPOINT"]
      },
      {
        "name" : "S3_BUCKET",
        "value" : local.envs["S3_BUCKET"]
      },
      {
        "name" : "S3_REGION",
        "value" : local.envs["S3_REGION"]
      },
      {
        "name" : "RESULTS_CACHE_ENABLED",
        "value" : "true"
      },
      {
        "name" : "AUTOCOMPLETE_CACHE_ENABLED",
        "value" : "true"
      },
      {
        "name" : "CACHE_STALE_TIME_SECONDS",
        "value" : "86400"
      }

    ]

    portMappings = [{
      containerPort = 8080
      hostPort      = 8080
      protocol      = "tcp"
    }]

    ulimits = [{
      hardLimit = 65535
      name      = "nofile"
      softLimit = 65535
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-group"         = aws_cloudwatch_log_group.lightdash_ecs_log_group.name
        "awslogs-stream-prefix" = "lightdash-ecs"
      }
    }
    }
  ])
}
