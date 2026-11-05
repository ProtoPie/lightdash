resource "aws_lb_target_group" "lightdash_target_group" {
  tags = merge(
    local.common_tags,
    {
      Product = "webx"
    }
  )
  name        = "lightdash-target-group"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    interval            = 10
    path                = "/api/v1/health"
    healthy_threshold   = 2
    unhealthy_threshold = 10
  }

  # Faster rollouts: drain the old task in 30s (AWS default 300s). Requests still in flight
  # after 30s are cut when a deploy replaces the task.
  deregistration_delay          = 30
  load_balancing_algorithm_type = "least_outstanding_requests"
}