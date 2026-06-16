
variable "lightdash_cpu" {
  description = "Total Fargate task CPU units, shared by lightdash + browserless containers (1 vCPU = 1024 CPU units)"
  default     = 2048
}

variable "lightdash_memory" {
  description = "Total Fargate task memory in MiB, shared by lightdash + browserless containers"
  default     = 4096
}

variable "lightdash_container_cpu" {
  description = "CPU units allocated to the lightdash container"
  default     = 1024
}

variable "lightdash_container_memory" {
  description = "Memory (MiB) allocated to the lightdash container"
  default     = 2560
}

variable "browserless_image" {
  description = "Browserless Chromium image used for headless screenshots / PDF export"
  default     = "ghcr.io/browserless/chromium:v2.24.3"
}

variable "browserless_container_cpu" {
  description = "CPU units allocated to the browserless sidecar"
  default     = 1024
}

variable "browserless_container_memory" {
  description = "Memory (MiB) allocated to the browserless sidecar"
  default     = 1536
}

variable "lightdash_oci_tag" {
  description = "container image tag"
  default     = "latest"
}

variable "lightdash_image_repo" {
  description = "ECR repo for the ProtoPie-customized Lightdash image (prod cutover from upstream stock image)"
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
    image     = "${var.lightdash_image_repo}:${var.lightdash_oci_tag}"
    cpu       = var.lightdash_container_cpu
    memory    = var.lightdash_container_memory
    essential = true

    dependsOn = [{
      containerName = "browserless"
      condition     = "START"
    }]

    environment = [

      {
        "name"  = "NODE_ENV",
        "value" = local.envs["NODE_ENV"]
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
      # Fixed topology: lightdash talks to the browserless sidecar over the
      # awsvpc loopback (same Fargate task ENI). Do not read from .env — an
      # operator pasting docker-compose values (e.g. "headless-browser") would
      # break headless rendering.
      {
        "name" : "HEADLESS_BROWSER_HOST",
        "value" : "localhost"
      },
      {
        "name" : "HEADLESS_BROWSER_PORT",
        "value" : "3001"
      },

      {
        "name" : "PGHOST",
        "value" : module.lightdash_db.db_instance_address
      },
      {
        "name" : "PGPORT",
        "value" : tostring(module.lightdash_db.db_instance_port)
      },
      {
        "name" : "PGUSER",
        "value" : local.envs["PGUSER"]
      },
      {
        "name" : "PGDATABASE",
        "value" : local.envs["PGDATABASE"]
      },
      {
        # Lightdash/knex SSL mode for Postgres connection. "no-verify" = require
        # TLS but skip CA cert verification (RDS uses AWS-managed CA). Required
        # while rds.force_ssl is in effect on the live DB.
        "name" : "PGSSLMODE",
        "value" : "no-verify"
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
        "name" : "EMAIL_SMTP_SENDER_EMAIL",
        "value" : local.envs["EMAIL_SMTP_SENDER_EMAIL"]
      },
      {
        "name" : "SLACK_CLIENT_ID",
        "value" : local.envs["SLACK_CLIENT_ID"]
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

    secrets = [
      for k in [
        "LIGHTDASH_SECRET",
        "PGPASSWORD",
        "EMAIL_SMTP_PASSWORD",
        "AUTH_OKTA_OAUTH_CLIENT_SECRET",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_STATE_SECRET",
        ] : {
        name      = k
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/lightdash/${local.env_name}/${k}"
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
    },
    {
      name      = "browserless"
      image     = var.browserless_image
      cpu       = var.browserless_container_cpu
      memory    = var.browserless_container_memory
      essential = true

      portMappings = [{
        containerPort = 3001
        hostPort      = 3001
        protocol      = "tcp"
      }]

      environment = [
        {
          "name" : "TIMEOUT",
          "value" : "120000"
        },
        {
          "name" : "CONCURRENT",
          "value" : "5"
        },
        {
          "name" : "PORT",
          "value" : "3001"
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-group"         = aws_cloudwatch_log_group.lightdash_ecs_log_group.name
          "awslogs-stream-prefix" = "browserless"
        }
      }
    }
  ])
}
